import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { join } from 'node:path';
import { z } from 'zod';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { getAllCommunities } from '../../src/store/communities.js';
import { Embedder } from '../../src/embeddings/embedder.js';
import { IndexPipeline } from '../../src/pipeline/indexer.js';
import { registerReindexTool } from '../../src/tools/reindex.js';
import type { ServerContext } from '../../src/context.js';

const FIXTURE_VAULT = join(import.meta.dirname, '..', 'fixtures', 'vault');

/**
 * Mock of `McpServer.tool()` that also replays the schema-based input
 * validation the real MCP SDK applies before dispatching to the handler.
 * This is load-bearing for v1.4.0 — A3 moved `resolution` from `.optional()`
 * to `.default(1.0)`, so the SDK must actually fill in the default before
 * the handler sees its args. A mock that skips validation would hide the
 * whole behaviour change.
 */
interface RecordedTool {
  name: string;
  description: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cb: (args: any) => Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any;
}

function makeValidatingMockServer(): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server: any;
  registered: RecordedTool[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  invoke: (name: string, rawArgs: Record<string, unknown>) => Promise<any>;
} {
  const registered: RecordedTool[] = [];
  const server = {
    tool(
      name: string,
      description: string,
      schema: Record<string, z.ZodTypeAny>,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cb: (args: any) => Promise<any>,
    ): void {
      registered.push({ name, description, cb, schema });
    },
  };
  const invoke = async (
    name: string,
    rawArgs: Record<string, unknown>,
  ): Promise<unknown> => {
    const tool = registered.find((t) => t.name === name);
    if (!tool) throw new Error(`tool not registered: ${name}`);
    const parsed = z.object(tool.schema).parse(rawArgs);
    return tool.cb(parsed);
  };
  return { server, registered, invoke };
}

/**
 * Reindex behaviour around community detection.
 *
 * v1.4.0: `resolution` was `.optional()` and bare `reindex({})` skipped
 * Louvain even on a non-empty vault. Fix landed by defaulting to 1.0.
 *
 * v1.7.19 (C6): the default-1.0 made every bare `reindex({})` rerun
 * Louvain even when nothing changed (~25 s on a 10k-note vault). We
 * reverted to `.optional()` and rely on the indexer's guard chain
 * (`nodesIndexed > 0 || stubNodesCreated > 0 || explicitResolution ||
 * deletionCount > 0`) to fire community detection only when warranted.
 *
 * The two assertions below cover both directions:
 *   1. First-time bare reindex still triggers Louvain (nodesIndexed > 0
 *      satisfies the guard).
 *   2. Second bare reindex on the same unchanged vault SKIPS Louvain
 *      (this is the C6 fix — saves ~25 s on no-op reruns).
 *   3. Explicit resolution always reruns Louvain (forces it via the
 *      `explicitResolution` branch of the guard).
 */
describe.sequential('tools/reindex - community detection guard (C6)', () => {
  let db: DatabaseHandle;
  let embedder: Embedder;
  let pipeline: IndexPipeline;

  beforeAll(async () => {
    db = openDb(':memory:');
    embedder = new Embedder();
    await embedder.init();
    pipeline = new IndexPipeline(db, embedder);
  }, 180_000);

  afterAll(async () => {
    db.close();
    await embedder.dispose();
  });

  it('first-time bare reindex({}) triggers community detection on a non-empty vault', async () => {
    const { server, invoke } = makeValidatingMockServer();
    const ctx = {
      db,
      pipeline,
      config: { vaultPath: FIXTURE_VAULT },
      ensureEmbedderReady: async () => undefined,
    } as unknown as ServerContext;
    registerReindexTool(server, ctx);

    const result = await invoke('reindex', {});
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.communitiesDetected).toBeGreaterThan(0);
    expect(getAllCommunities(db).length).toBeGreaterThan(0);
  }, 180_000);

  it('C6: second bare reindex on an unchanged vault SKIPS community detection (no-op short-circuit)', async () => {
    const { server, invoke } = makeValidatingMockServer();
    const ctx = {
      db,
      pipeline,
      config: { vaultPath: FIXTURE_VAULT },
      ensureEmbedderReady: async () => undefined,
    } as unknown as ServerContext;
    registerReindexTool(server, ctx);

    const result = await invoke('reindex', {});
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    // No new nodes, no new stubs, no deletions, no explicit resolution
    // → guard short-circuits → communitiesDetected omitted (or zero).
    expect(payload.nodesIndexed).toBe(0);
    expect(payload.communitiesDetected ?? 0).toBe(0);
  }, 60_000);

  it('C6: explicit resolution always reruns community detection even on no-op vault', async () => {
    const { server, invoke } = makeValidatingMockServer();
    const ctx = {
      db,
      pipeline,
      config: { vaultPath: FIXTURE_VAULT },
      ensureEmbedderReady: async () => undefined,
    } as unknown as ServerContext;
    registerReindexTool(server, ctx);

    const result = await invoke('reindex', { resolution: 1.5 });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.nodesIndexed).toBe(0);
    expect(payload.communitiesDetected).toBeGreaterThan(0);
  }, 60_000);
});
