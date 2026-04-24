import { stat } from 'fs/promises';
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

    const stats: IndexStats = {
      nodesIndexed: 0,
      nodesSkipped: 0,
      edgesIndexed: 0,
      communitiesDetected: 0,
      stubNodesCreated: 0,
      chunksOk: 0,
      chunksSkipped: 0,
    };

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

    return stats;
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
    await this.embedChunks(node.id, node.content, stats);

    // Note-level mean-pooled fallback — kept so the legacy nodes_vec table
    // still has a row per note, which older tools (and backward-compat
    // callers) rely on. Deprecated in v1.4.0; remove once all callers
    // route through chunks_vec.
    const tags = Array.isArray(node.frontmatter.tags) ? node.frontmatter.tags : [];
    const noteText = TransformersEmbedder.buildEmbeddingText(node.title, tags as string[], node.content);
    const noteEmbedding = await this.embedder.embed(noteText, 'document');
    upsertEmbedding(this.db, node.id, noteEmbedding);

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
   * Finally, we drop any chunk rows that are no longer present (note got
   * shorter, heading got renamed, etc.).
   */
  private async embedChunks(nodeId: string, content: string, stats: IndexStats): Promise<void> {
    const chunks = chunkMarkdown(content, this.chunkerConfig);
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

