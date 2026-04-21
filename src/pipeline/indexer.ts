import { stat } from 'fs/promises';
import { join } from 'path';
import { parseVault, parseSingleFile } from '../vault/parser.js';
import type { DatabaseHandle } from '../store/db.js';
import { upsertNode, getNode, deleteNode } from '../store/nodes.js';
import { insertEdge, deleteEdgesBySource } from '../store/edges.js';
import { upsertEmbedding } from '../store/embeddings.js';
import {
  getAllSyncPaths,
  getSyncMtime,
  setSyncMtime,
} from '../store/sync.js';
import { Embedder } from '../embeddings/embedder.js';
import { KnowledgeGraph } from '../graph/builder.js';
import { detectCommunities } from '../graph/communities.js';
import { clearCommunities, upsertCommunity } from '../store/communities.js';
import type { ParsedNode, ParsedEdge } from '../types.js';

export interface IndexStats {
  nodesIndexed: number;
  nodesSkipped: number;
  edgesIndexed: number;
  communitiesDetected: number;
  stubNodesCreated: number;
}

export interface SingleNoteResult {
  indexed: boolean;
  skipped: boolean;
  deleted: boolean;
  edgesIndexed: number;
  stubsCreated: number;
}

export class IndexPipeline {
  constructor(
    private db: DatabaseHandle,
    private embedder: Embedder,
  ) {}

  async index(vaultPath: string, resolution?: number): Promise<IndexStats> {
    const stats: IndexStats = {
      nodesIndexed: 0,
      nodesSkipped: 0,
      edgesIndexed: 0,
      communitiesDetected: 0,
      stubNodesCreated: 0,
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
    };
    await this.applyNode(node, edges, fileStat.mtimeMs, stats);
    stats.stubNodesCreated += this.materialiseStubs(stubIds);

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

    const tags = Array.isArray(node.frontmatter.tags) ? node.frontmatter.tags : [];
    const text = Embedder.buildEmbeddingText(node.title, tags as string[], node.content);
    const embedding = await this.embedder.embed(text);
    upsertEmbedding(this.db, node.id, embedding);

    deleteEdgesBySource(this.db, node.id);
    for (const edge of nodeEdges) {
      insertEdge(this.db, edge);
      stats.edgesIndexed++;
    }

    setSyncMtime(this.db, node.id, mtime);
    stats.nodesIndexed++;
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

