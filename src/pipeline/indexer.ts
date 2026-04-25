import { stat } from 'fs/promises';
import { createHash } from 'node:crypto';
import { basename, join } from 'path';
import { parseVault, parseSingleFile } from '../vault/parser.js';
import type { DatabaseHandle } from '../store/db.js';
import { upsertNode, getNode, deleteNode, migrateStubToReal, pruneAllOrphanStubs } from '../store/nodes.js';
import { insertEdge, deleteEdgesBySource } from '../store/edges.js';
import { upsertEmbedding } from '../store/embeddings.js';
import {
  getAllSyncPaths,
  getSyncMtime,
  setSyncMtime,
} from '../store/sync.js';
import {
  upsertChunkRow,
  upsertChunkVector,
  getChunk,
  getChunkIdsForNode,
  deleteChunks,
} from '../store/chunks.js';
import { TransformersEmbedder } from '../embeddings/embedder.js';
import type { Embedder } from '../embeddings/types.js';
import {
  chunkMarkdown,
  chunkId,
  buildChunkEmbeddingText,
  DEFAULT_CHUNKER_CONFIG,
  type Chunk,
  type ChunkerConfig,
} from '../embeddings/chunker.js';
import { KnowledgeGraph } from '../graph/builder.js';
import { detectCommunities } from '../graph/communities.js';
import { clearCommunities, upsertCommunity } from '../store/communities.js';
import type { ParsedNode, ParsedEdge } from '../types.js';
import { errorMessage } from '../util/errors.js';
import {
  getCapacity,
  recordFailedChunk,
  reduceDiscoveredMaxTokens,
  resetDiscoveredCapacity,
  type EmbedderCapacity,
} from '../embeddings/capacity.js';

/**
 * Regex patterns that indicate a chunk is too large for the embedder.
 * On these errors we skip the chunk and continue rather than aborting the
 * entire reindex (research-backed: NAACL 2025 + production libraries
 * LangChain / LlamaIndex / FastEmbed / Haystack all do skip+log).
 */
const TOO_LONG_PATTERNS = [
  /input length exceeds/i,
  /context length/i,
  /too many tokens/i,
  /maximum context length/i,
  /HTTP 400.*length/i,
  /input_too_long/i,
  /Cannot broadcast|shape mismatch/i,
];

/**
 * Regex patterns that indicate the embedder itself is dead / unreachable.
 * On these errors we re-throw so the whole reindex pass aborts — per-chunk
 * retry doesn't make sense when the host is down.
 *
 * "Offline / network" means the TCP layer is broken: the host refused the
 * connection, DNS failed, or the connection was reset. We deliberately do NOT
 * match on the bare word "network" because ONNX Runtime surfaces errors like
 * "neural network input tensor shape mismatch" that contain "network" but are
 * actually chunk-too-long errors — those should be skipped, not aborted.
 */
const DEAD_EMBEDDER_PATTERNS = [
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /ECONNRESET/i,
  /getaddrinfo/i,
  // Generic phrasing for fetch/HTTP clients that surface "network error",
  // "network down", or "network unreachable" — but not "neural network".
  /network (error|down|unreachable)/i,
  /EmbedderLoadError/i,
  /kind.*offline/i,
];

function isTooLongError(msg: string): boolean {
  return TOO_LONG_PATTERNS.some((re) => re.test(msg));
}

function isDeadEmbedderError(msg: string): boolean {
  return DEAD_EMBEDDER_PATTERNS.some((re) => re.test(msg));
}

export interface IndexStats {
  nodesIndexed: number;
  nodesSkipped: number;
  edgesIndexed: number;
  communitiesDetected: number;
  stubNodesCreated: number;
  chunksOk: number;
  chunksSkipped: number;
  notesMissingEmbeddings: number;
  /**
   * Notes whose body had nothing chunkable (frontmatter-only, embeds-only,
   * shorter than minChunkChars). v1.7.3+ embeds a title-based fallback for
   * these so they remain searchable; this counter tracks how many used the
   * fallback path. A note with truly nothing to embed (no title, no
   * frontmatter, no body) is recorded in `failed_chunks` with reason
   * `'no-embeddable-content'` and is excluded from `notesMissingEmbeddings`.
   */
  notesNoEmbeddableContent: number;
}

/**
 * Minimum length (chars) of a fallback embedding text before we accept it.
 * Below this, the note has no meaningful identity to embed and we record it
 * as `'no-embeddable-content'` instead.
 */
const MIN_FALLBACK_CHARS = 3;

/**
 * Build a synthetic embedding text for a note whose body produced zero chunks
 * (empty file, frontmatter-only, embeds-only, sub-`minChunkChars` body).
 * Combines title + tags + scalar frontmatter values + first 5 wikilink/embed
 * targets. Returns '' if nothing meaningful can be assembled — the caller
 * treats that as `'no-embeddable-content'`.
 */
function buildTitleFallbackText(node: ParsedNode): string {
  const parts: string[] = [];
  if (node.title) parts.push(node.title);

  const fmTags = node.frontmatter.tags;
  const tags = Array.isArray(fmTags) ? (fmTags as unknown[]).filter((t): t is string => typeof t === 'string') : [];
  if (tags.length > 0) parts.push(tags.join(', '));

  for (const [key, val] of Object.entries(node.frontmatter)) {
    if (key === 'tags' || key.startsWith('_')) continue;
    if (typeof val === 'string' && val.trim()) parts.push(`${key}: ${val.trim()}`);
    else if (typeof val === 'number' || typeof val === 'boolean') parts.push(`${key}: ${val}`);
  }

  // Pull up to 5 wikilink/embed target names from the body so embeds-only
  // collector notes (`![[a.png]] ![[b.png]]`) still have searchable text.
  const linkRe = /!?\[\[([^\]|#^]+)/g;
  const links: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(node.content)) !== null && links.length < 5) {
    const target = m[1].trim();
    if (target) links.push(target);
  }
  if (links.length > 0) parts.push(`Links: ${links.join(', ')}`);

  return parts.join('\n');
}

export interface SingleNoteResult {
  indexed: boolean;
  skipped: boolean;
  deleted: boolean;
  edgesIndexed: number;
  stubsCreated: number;
}

export class IndexPipeline {
  private chunkerConfig: ChunkerConfig;
  /** Cached capacity for this pipeline instance. Fetched on first use. */
  private capacity: EmbedderCapacity | null = null;

  constructor(
    private db: DatabaseHandle,
    private embedder: Embedder,
    chunkerConfig: ChunkerConfig = DEFAULT_CHUNKER_CONFIG,
  ) {
    this.chunkerConfig = chunkerConfig;
  }

  /**
   * Fetch (or re-fetch) the embedder's token capacity and update the chunker
   * config's `chunkSize` from `capacity.chunkBudgetChars`. All other chunker
   * options (headingSplitDepth, minChunkChars, etc.) are preserved, so any
   * values passed at construction time remain in effect.
   *
   * Called implicitly on the first `index()` / `indexSingleNote()` call so
   * callers don't need to await it manually. Expose publicly so a caller can
   * force a refresh (e.g. after an Ollama model swap).
   */
  async refreshCapacity(): Promise<void> {
    this.capacity = await getCapacity(this.db, this.embedder);
    // Spread the current config so caller-provided options (headingSplitDepth,
    // minChunkChars, preserveCodeBlocks, etc.) are not reset.
    this.chunkerConfig = { ...this.chunkerConfig, chunkSize: this.capacity.chunkBudgetChars };
  }

  /** Ensure capacity has been loaded at least once. */
  private async ensureCapacity(): Promise<void> {
    if (this.capacity === null) {
      await this.refreshCapacity();
    }
  }

  async index(vaultPath: string, resolution?: number): Promise<IndexStats> {
    await this.ensureCapacity();

    // v1.7.3 — wipe any drift in `discovered_max_tokens` from previous runs
    // and reload our in-memory chunker config from advertised. Prevents the
    // runaway-ratchet failure mode (one freak chunk shrinks the budget for
    // every note in this vault) that bit users on v1.7.0–v1.7.2.
    resetDiscoveredCapacity(this.db, this.embedder);
    await this.refreshCapacity();

    const stats: IndexStats = {
      nodesIndexed: 0,
      nodesSkipped: 0,
      edgesIndexed: 0,
      communitiesDetected: 0,
      stubNodesCreated: 0,
      chunksOk: 0,
      chunksSkipped: 0,
      notesMissingEmbeddings: 0,
      notesNoEmbeddableContent: 0,
    };

    try {
      const { nodes, edges, stubIds } = await parseVault(vaultPath);
      const previousPaths = new Set(getAllSyncPaths(this.db));

      // Detect deleted files. Count them so we can trigger a community refresh
      // for delete-only reindex runs (where nothing else changed).
      const currentPaths = new Set(nodes.map((n) => n.id));
      let deletionCount = 0;
      for (const oldPath of previousPaths) {
        if (!currentPaths.has(oldPath)) {
          deleteNode(this.db, oldPath);
          deletionCount++;
        }
      }

      // Index nodes (incremental)
      for (const node of nodes) {
        const fileStat = await stat(join(vaultPath, node.id));
        await this.applyNode(
          node,
          edges.filter((e) => e.sourceId === node.id),
          fileStat.mtimeMs,
          stats,
        );
      }

      stats.stubNodesCreated += this.materialiseStubs(stubIds);

      // Refresh community detection when anything meaningful changed, OR when
      // the caller explicitly asked for a particular resolution (explicit intent
      // = they want fresh communities even if mtimes didn't move), OR when
      // files were deleted (orphan cleanup in the communities table).
      const explicitResolution = resolution !== undefined;
      if (
        stats.nodesIndexed > 0 ||
        stats.stubNodesCreated > 0 ||
        explicitResolution ||
        deletionCount > 0
      ) {
        stats.communitiesDetected = this.refreshCommunities(resolution ?? 1.0);
      }

      // Resolve forward-reference stubs: if a stub's bare stem now matches a
      // real note, repoint its inbound edges to the real note and delete the
      // stub. Then prune any remaining stubs with zero inbound edges (covers
      // orphans from pre-v1.5.8 move/delete operations).
      this.resolveForwardStubs();
      pruneAllOrphanStubs(this.db);

      // Emit a summary only when chunks were skipped so the happy path stays quiet.
      if (stats.chunksSkipped > 0) {
        process.stderr.write(
          `obsidian-brain: indexed ${stats.nodesIndexed} notes (${stats.chunksOk} chunks ok, ${stats.chunksSkipped} chunks skipped).\n`,
        );
      }

      // F6 v1.7.3 — Self-heal becomes a *true* diagnostic, not a retry-loop.
      //
      // Two changes vs v1.7.2:
      // 1. Check `chunks_vec` membership, not just `chunks` — notes whose
      //    chunk rows exist but failed to embed (drift cascade, transient
      //    embedder errors) DO need retry on next boot. v1.7.2's query
      //    missed this case.
      // 2. Exclude notes recorded as 'no-embeddable-content'. Those will
      //    fail the same way next pass, so wiping their `sync.mtime`
      //    creates the infinite no-op loop the user hit.
      const unexpectedMissing = (this.db.prepare(`
        SELECT COUNT(*) AS n FROM nodes
        WHERE id NOT LIKE '_stub/%' ESCAPE '\\'
          AND id NOT IN (
            SELECT DISTINCT c.node_id FROM chunks c
            JOIN chunks_vec v ON c.rowid = v.rowid
            WHERE c.node_id IS NOT NULL
          )
          AND id NOT IN (SELECT DISTINCT note_id FROM failed_chunks WHERE reason = 'no-embeddable-content')
      `).get() as { n: number }).n;

      if (unexpectedMissing > 0) {
        process.stderr.write(
          `obsidian-brain: ${unexpectedMissing} notes have no successful embedding — wiping sync.mtime to retry on next boot\n`,
        );
        this.db.prepare(`
          DELETE FROM sync WHERE path IN (
            SELECT id FROM nodes
            WHERE id NOT LIKE '_stub/%' ESCAPE '\\'
              AND id NOT IN (
                SELECT DISTINCT c.node_id FROM chunks c
                JOIN chunks_vec v ON c.rowid = v.rowid
                WHERE c.node_id IS NOT NULL
              )
              AND id NOT IN (SELECT DISTINCT note_id FROM failed_chunks WHERE reason = 'no-embeddable-content')
          )
        `).run();
      }
      stats.notesMissingEmbeddings = unexpectedMissing;

      const noContentTotal = (this.db.prepare(
        `SELECT COUNT(DISTINCT note_id) AS n FROM failed_chunks WHERE reason = 'no-embeddable-content'`,
      ).get() as { n: number }).n;
      stats.notesNoEmbeddableContent = noContentTotal;
      if (noContentTotal > 0) {
        process.stderr.write(
          `obsidian-brain: ${noContentTotal} notes have no embeddable content (empty / frontmatter-only / sub-minChunkChars body) — recorded as 'no-embeddable-content' in failed_chunks; will not retry until the file changes\n`,
        );
      }

      return stats;
    } catch (err) {
      const msg = errorMessage(err);
      if (/too (few|many) parameter values|stmt\.run|prepared statement|no such (table|column)/i.test(msg)) {
        process.stderr.write(
          `obsidian-brain: SQL error during reindex — likely schema drift or stale npx cache. Run: rm -rf ~/.npm/_npx && relaunch. Error: ${msg.slice(0, 300)}\n`,
        );
        // Re-throw with a clearer wrapper so MCP clients see actionable text instead of the cryptic SQLite wording.
        throw new Error(`reindex failed: SQL error (likely schema drift or stale install) — ${msg}`);
      }
      throw err; // unrelated errors bubble up unchanged
    }
  }

  /**
   * Reindex exactly one file. Called by the watcher on every debounced change
   * event. Community detection is NOT refreshed here — the caller (watcher)
   * batches that at a separate, longer cadence so we don't re-run Louvain on
   * every keystroke.
   */
  async indexSingleNote(
    vaultPath: string,
    relPath: string,
    event: 'add' | 'change' | 'unlink',
  ): Promise<SingleNoteResult> {
    await this.ensureCapacity();

    if (event === 'unlink') {
      const existed = getNode(this.db, relPath) !== undefined;
      deleteNode(this.db, relPath);
      return {
        indexed: false,
        skipped: false,
        deleted: existed,
        edgesIndexed: 0,
        stubsCreated: 0,
      };
    }

    const fileStat = await stat(join(vaultPath, relPath));

    // Treat the sync table as the best-effort list of "files the indexer
    // currently knows about" — good enough to build a stem lookup for wiki
    // link resolution. New files created during a watcher session get added
    // to this list as they arrive.
    const allPaths = getAllSyncPaths(this.db);
    if (!allPaths.includes(relPath)) allPaths.push(relPath);

    const { node, edges, stubIds } = await parseSingleFile(
      vaultPath,
      relPath,
      allPaths,
    );

    const stats: IndexStats = {
      nodesIndexed: 0,
      nodesSkipped: 0,
      edgesIndexed: 0,
      communitiesDetected: 0,
      stubNodesCreated: 0,
      chunksOk: 0,
      chunksSkipped: 0,
      notesMissingEmbeddings: 0,
      notesNoEmbeddableContent: 0,
    };
    await this.applyNode(node, edges, fileStat.mtimeMs, stats);
    stats.stubNodesCreated += this.materialiseStubs(stubIds);

    // Resolve any forward-reference stub for this note's bare stem. Mirrors
    // what `create_note` already does: when another note wrote `[[X]]` before
    // `X.md` existed, a `_stub/X.md` node was materialised. Now that the real
    // note is indexed, repoint all inbound edges and delete the stub. The
    // full `index()` path handles this via `resolveForwardStubs`, but the
    // single-file path is what the watcher calls — and without this, edges
    // sit on stub targets forever, which is exactly how `move_note` ends up
    // missing them when it later queries `getEdgesByTarget(oldPath)`.
    const stem = basename(relPath, '.md');
    if (stem) {
      migrateStubToReal(this.db, `_stub/${stem}.md`, relPath);
    }

    return {
      indexed: stats.nodesIndexed > 0,
      skipped: stats.nodesSkipped > 0,
      deleted: false,
      edgesIndexed: stats.edgesIndexed,
      stubsCreated: stats.stubNodesCreated,
    };
  }

  /**
   * Re-run Louvain community detection over the current graph and rewrite
   * the communities table. Exposed so watchers can schedule it independently
   * from per-file reindex.
   */
  refreshCommunities(resolution = 1.0): number {
    const kg = KnowledgeGraph.fromStore(this.db);
    const communities = detectCommunities(kg.toUndirected(), resolution);
    clearCommunities(this.db);
    for (const c of communities) {
      upsertCommunity(this.db, c);
    }
    return communities.length;
  }

  private async applyNode(
    node: ParsedNode,
    nodeEdges: ParsedEdge[],
    mtime: number,
    stats: IndexStats,
  ): Promise<void> {
    const prevMtime = getSyncMtime(this.db, node.id);
    if (prevMtime !== undefined && prevMtime >= mtime) {
      stats.nodesSkipped++;
      return;
    }

    upsertNode(this.db, node);

    // Per-chunk embeddings. Each chunk is hashed + content-addressed so an
    // unchanged chunk skips the (expensive) embed call across reindex runs.
    await this.embedChunks(node, stats);

    // Note-level mean-pooled fallback — kept so the legacy nodes_vec table
    // still has a row per note, which older tools (and backward-compat
    // callers) rely on. Deprecated in v1.4.0; remove once all callers
    // route through chunks_vec.
    const tags = Array.isArray(node.frontmatter.tags) ? node.frontmatter.tags : [];
    const noteText = TransformersEmbedder.buildEmbeddingText(node.title, tags as string[], node.content);
    try {
      const noteEmbedding = await this.embedder.embed(noteText, 'document');
      if (!noteEmbedding || (noteEmbedding as Float32Array).length === 0) {
        throw new Error('embedder returned empty/invalid vector for note');
      }
      upsertEmbedding(this.db, node.id, noteEmbedding);
    } catch (err) {
      const msg = errorMessage(err);
      if (isDeadEmbedderError(msg)) throw err; // ECONNREFUSED → abort full pass
      process.stderr.write(
        `obsidian-brain: note-level embedding failed — skipping (node: ${node.id}, chars: ${noteText.length}, reason: ${msg.slice(0, 200)})\n`,
      );
      recordFailedChunk(this.db, `${node.id}#note`, node.id, isTooLongError(msg) ? 'note-too-long' : 'note-embed-error', msg.slice(0, 500));
      // Note-level embedding is a fallback for the legacy `nodes_vec` table; missing
      // it is not catastrophic — chunk-level vectors still drive semantic search.
    }

    deleteEdgesBySource(this.db, node.id);
    for (const edge of nodeEdges) {
      insertEdge(this.db, edge);
      stats.edgesIndexed++;
    }

    setSyncMtime(this.db, node.id, mtime);
    stats.nodesIndexed++;
  }

  /**
   * Produce per-chunk embeddings for a note. For each fresh chunk we:
   *
   *   - compare `content_hash` against the stored row (same → reuse the
   *     existing vector, skipping the embedder call)
   *   - otherwise re-embed + upsert
   *
   * Each embed call is guarded: if the embedder reports "too long" (HTTP 400,
   * ONNX shape mismatch, token-limit errors from any provider) we skip the
   * chunk and continue. If the embedder appears dead (ECONNREFUSED, network
   * errors) we re-throw so the whole pass aborts.
   *
   * Empty / frontmatter-only / embeds-only notes (`chunkMarkdown` returns [])
   * get a title-based fallback chunk synthesised from title + tags +
   * frontmatter scalars + first 5 wikilink targets. This keeps daily notes,
   * MOC stubs, and template-only files searchable. v1.7.3+ behaviour — the
   * pre-v1.7.3 path silently dropped these, producing the user-reported 32%
   * "missing embeddings" count.
   *
   * Finally, we drop any chunk rows that are no longer present (note got
   * shorter, heading got renamed, etc.).
   */
  private async embedChunks(node: ParsedNode, stats: IndexStats): Promise<void> {
    const nodeId = node.id;
    const chunks = chunkMarkdown(node.content, this.chunkerConfig);

    // F1 v1.7.3 — title-fallback synthesis for notes with nothing chunkable.
    if (chunks.length === 0) {
      const fallbackText = buildTitleFallbackText(node);
      if (fallbackText.trim().length < MIN_FALLBACK_CHARS) {
        // Truly empty (no title, no frontmatter, no body) — record so
        // index_status can surface it as a distinct bucket and so we don't
        // infinite-loop retrying it on every reindex.
        recordFailedChunk(this.db, `${nodeId}#no-content`, nodeId, 'no-embeddable-content', null);
        stats.notesNoEmbeddableContent++;
        // Still drop any stale chunks (covers the "note had body, got
        // emptied to whitespace" transition) before returning.
        const previousIds = getChunkIdsForNode(this.db, nodeId);
        if (previousIds.length > 0) deleteChunks(this.db, previousIds);
        return;
      }
      const synth: Chunk = {
        chunkIndex: 0,
        heading: node.title || null,
        headingLevel: null,
        content: fallbackText,
        contentHash: createHash('sha256').update(fallbackText).digest('hex'),
        startLine: 0,
        endLine: 0,
      };
      chunks.push(synth);
      // If this note had previously been recorded as 'no-embeddable-content'
      // but now has a usable fallback (e.g., user added a title), clear the
      // stale failure record so it doesn't pollute index_status counts.
      this.db.prepare('DELETE FROM failed_chunks WHERE chunk_id = ?').run(`${nodeId}#no-content`);
    }

    const freshIds = new Set<string>();

    for (const chunk of chunks) {
      const id = chunkId(nodeId, chunk.chunkIndex);
      freshIds.add(id);

      const existing = getChunk(this.db, id);
      if (existing && existing.contentHash === chunk.contentHash) {
        // Row is still accurate + the vector was written on the previous
        // pass. Nothing to do — biggest win on a repeated index of an
        // unchanged note.
        stats.chunksOk++;
        continue;
      }

      const rowid = upsertChunkRow(this.db, nodeId, chunk);
      try {
        const vec = await this.embedder.embed(buildChunkEmbeddingText(chunk), 'document');
        upsertChunkVector(this.db, rowid, vec);
        stats.chunksOk++;
      } catch (err) {
        const msg = errorMessage(err);

        if (isDeadEmbedderError(msg)) {
          // Embedder is unreachable — abort the whole pass.
          throw err;
        }

        const reason = isTooLongError(msg) ? 'too-long' : 'embed-error';

        if (reason === 'too-long') {
          // Chunk is too large for this embedder model — skip it.
          process.stderr.write(
            `obsidian-brain: chunk too large for embedder — skipping (node: ${nodeId}, chunk: ${chunk.chunkIndex}, chars: ${chunk.content.length})\n`,
          );
        } else {
          // Unknown error — treat as too-long (better to skip than halt).
          process.stderr.write(
            `obsidian-brain: chunk embed failed with unrecognised error — skipping (node: ${nodeId}, chunk: ${chunk.chunkIndex}, chars: ${chunk.content.length}): ${msg}\n`,
          );
        }

        // Persist the failure to the failed_chunks table so subsequent index
        // passes can skip known-bad chunks without re-attempting them, and so
        // the adaptive capacity system can see the failure distribution.
        const truncatedMsg = msg.slice(0, 500);
        recordFailedChunk(this.db, id, nodeId, reason, truncatedMsg);

        // Shrink the cached discovered token ceiling so the next reindex
        // uses a smaller chunkSize. Token count is approximated from char
        // length using the same CHARS_PER_TOKEN factor as capacity.ts.
        const approxTokens = Math.ceil(chunk.content.length / 2.5);
        reduceDiscoveredMaxTokens(this.db, this.embedder, approxTokens);

        stats.chunksSkipped++;
      }
    }

    // Drop stale chunks (the note got shorter or a heading changed).
    const previousIds = getChunkIdsForNode(this.db, nodeId);
    const stale = previousIds.filter((id) => !freshIds.has(id));
    if (stale.length > 0) deleteChunks(this.db, stale);
  }

  /**
   * Scan all stub nodes. For each bare-stem stub (no `#` or `^`), look for a
   * real note whose vault-relative path ends with `${stem}.md`. If found,
   * repoint all inbound edges to the real node and delete the stub.
   *
   * This runs AFTER materialiseStubs so any new edges from the current index
   * pass are already stored before we attempt migration.
   */
  private resolveForwardStubs(): void {
    const rows = this.db
      .prepare("SELECT id FROM nodes WHERE json_extract(frontmatter, '$._stub') = 1")
      .all() as Array<{ id: string }>;

    for (const { id: stubId } of rows) {
      // Stub ids no longer contain `#` or `^` as of v1.6.5 — the parser
      // splits heading/anchor suffixes onto `edge.targetSubpath` (stored
      // as target_subpath column; was target_fragment pre-v1.6.11) before
      // building the stub id. Legacy fragment-embedded stubs (pre-v1.6.5)
      // still exist in upgraded databases until the post-migration
      // reindex runs, so skip them here; `pruneAllOrphanStubs` cleans
      // them up once their inbound edges are rewritten.
      const raw = stubId.replace(/^_stub\//, '').replace(/\.md$/, '');
      if (raw.includes('#') || raw.includes('^')) continue;

      // Find a real node whose id is exactly `${raw}.md` or ends with `/${raw}.md`
      // (i.e., the note exists as a top-level or nested file with that basename).
      const want = `${raw}.md`;
      const hit = this.db
        .prepare(
          "SELECT id FROM nodes WHERE (id = ? OR id LIKE ?) AND (frontmatter IS NULL OR json_extract(frontmatter, '$._stub') IS NULL) LIMIT 1"
        )
        .get(want, `%/${want}`) as { id: string } | undefined;

      if (hit) {
        migrateStubToReal(this.db, stubId, hit.id);
      }
    }
  }

  private materialiseStubs(stubIds: Set<string>): number {
    let created = 0;
    for (const stubId of stubIds) {
      if (!getNode(this.db, stubId)) {
        upsertNode(this.db, {
          id: stubId,
          title: stubId.replace('_stub/', '').replace('.md', ''),
          content: '',
          frontmatter: { _stub: true },
        });
        created++;
      }
    }
    return created;
  }
}

