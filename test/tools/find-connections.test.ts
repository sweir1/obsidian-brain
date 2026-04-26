import { describe, it, expect } from 'vitest';
import { registerFindConnectionsTool } from '../../src/tools/find-connections.js';
import { bootstrap } from '../../src/pipeline/bootstrap.js';
import { openDb } from '../../src/store/db.js';
import { upsertNode } from '../../src/store/nodes.js';
import type { ServerContext } from '../../src/context.js';
import type { Embedder } from '../../src/embeddings/types.js';

class StubEmbedder implements Embedder {
  constructor(
    private readonly _model: string,
    private readonly _dim: number,
    private readonly _provider: string = 'stub',
  ) {}
  async init(): Promise<void> { /* no-op */ }
  async embed(): Promise<Float32Array> { return new Float32Array(this._dim); }
  dimensions(): number { return this._dim; }
  modelIdentifier(): string { return this._model; }
  providerName(): string { return this._provider; }
  async dispose(): Promise<void> { /* no-op */ }
}

interface RecordedTool {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cb: (args: any) => Promise<any>;
}

function makeMockServer(): {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server: any;
  registered: RecordedTool[];
} {
  const registered: RecordedTool[] = [];
  const server = {
    tool(
      name: string,
      _description: string,
      _schema: unknown,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cb: (args: any) => Promise<any>,
    ): void {
      registered.push({ name, cb });
    },
  };
  return { server, registered };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrap(result: any): any {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

/**
 * v1.6.9 regression: `find_connections` walks the edges table via
 * KnowledgeGraph.fromStore → getEdgesBySource, which SELECTs target_subpath
 * (target_fragment before v1.6.11). If the migration chain is missing from
 * bootstrap, the column is absent on any pre-v4 DB and this handler throws
 * `no such column`.
 */
describe('tools/find_connections — schema migration regression', () => {
  it('succeeds on a DB that was pre-v4 before boot (bootstrap must heal the schema)', async () => {
    const db = openDb(':memory:');
    const emb = new StubEmbedder('Xenova/all-MiniLM-L6-v2', 384, 'transformers.js');

    // Stamp metadata so bootstrap treats subsequent boots as upgrades.
    bootstrap(db, emb);
    // Simulate a pre-v4 schema on disk: missing column + stale schema_version.
    // Simulate a pre-v5 DB by renaming target_subpath back to target_fragment,
    // then drop it entirely, then set schema_version = 3 (deep-pre-v4).
    db.exec('ALTER TABLE edges DROP COLUMN target_subpath');
    db.prepare("UPDATE index_metadata SET value = '3' WHERE key = 'schema_version'").run();

    // Seed two notes + one edge under the pre-v4 schema.
    upsertNode(db, { id: 'a.md', title: 'Alpha', content: 'x', frontmatter: {} });
    upsertNode(db, { id: 'b.md', title: 'Beta', content: 'x', frontmatter: {} });
    db.prepare(
      "INSERT INTO edges (source_id, target_id, context) VALUES ('a.md', 'b.md', 'link')",
    ).run();

    // Production boot path: bootstrap runs before tools answer queries.
    bootstrap(db, emb);

    const ctx = { db } as unknown as ServerContext;
    const { server, registered } = makeMockServer();
    registerFindConnectionsTool(server, ctx);
    const tool = registered.find((t) => t.name === 'find_connections')!;

    const result = unwrap(await tool.cb({ name: 'a.md', depth: 1 }));
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'b.md' })]),
    );

    db.close();
  });

  it('succeeds with returnSubgraph on the same pre-v4 DB', async () => {
    const db = openDb(':memory:');
    const emb = new StubEmbedder('Xenova/all-MiniLM-L6-v2', 384, 'transformers.js');

    bootstrap(db, emb);
    // Simulate a pre-v5 DB by renaming target_subpath back to target_fragment,
    // then drop it entirely, then set schema_version = 3 (deep-pre-v4).
    db.exec('ALTER TABLE edges DROP COLUMN target_subpath');
    db.prepare("UPDATE index_metadata SET value = '3' WHERE key = 'schema_version'").run();
    upsertNode(db, { id: 'a.md', title: 'Alpha', content: 'x', frontmatter: {} });
    upsertNode(db, { id: 'b.md', title: 'Beta', content: 'x', frontmatter: {} });
    db.prepare(
      "INSERT INTO edges (source_id, target_id, context) VALUES ('a.md', 'b.md', 'link')",
    ).run();

    bootstrap(db, emb);

    const ctx = { db } as unknown as ServerContext;
    const { server, registered } = makeMockServer();
    registerFindConnectionsTool(server, ctx);
    const tool = registered.find((t) => t.name === 'find_connections')!;

    const result = unwrap(await tool.cb({ name: 'a.md', depth: 2, returnSubgraph: true }));
    expect(result.data).toHaveProperty('nodes');
    expect(result.data).toHaveProperty('edges');

    db.close();
  });
});

describe('tools/find_connections — stub-filter default (G6)', () => {
  it('default excludes broken-wikilink stub neighbours', async () => {
    const db = openDb(':memory:');
    const emb = new StubEmbedder('Xenova/all-MiniLM-L6-v2', 384, 'transformers.js');
    bootstrap(db, emb);

    upsertNode(db, { id: 'a.md', title: 'Alpha', content: 'x', frontmatter: {} });
    upsertNode(db, { id: 'b.md', title: 'Beta', content: 'x', frontmatter: {} });
    upsertNode(db, {
      id: '_stub/Ghost.md',
      title: 'Ghost',
      content: '',
      frontmatter: { _stub: true },
    });
    db.prepare(
      "INSERT INTO edges (source_id, target_id, context) VALUES ('a.md', 'b.md', '')",
    ).run();
    db.prepare(
      "INSERT INTO edges (source_id, target_id, context) VALUES ('a.md', '_stub/Ghost.md', '')",
    ).run();

    const ctx = { db } as unknown as ServerContext;
    const { server, registered } = makeMockServer();
    registerFindConnectionsTool(server, ctx);
    const tool = registered.find((t) => t.name === 'find_connections')!;

    const defaultResult = unwrap(await tool.cb({ name: 'a.md', depth: 1 }));
    const defaultIds = (defaultResult.data as Array<{ id: string }>).map((n) => n.id);
    expect(defaultIds).toContain('b.md');
    expect(defaultIds).not.toContain('_stub/Ghost.md');

    const withStubs = unwrap(
      await tool.cb({ name: 'a.md', depth: 1, includeStubs: true }),
    );
    const withStubIds = (withStubs.data as Array<{ id: string }>).map((n) => n.id);
    expect(withStubIds).toContain('b.md');
    expect(withStubIds).toContain('_stub/Ghost.md');

    db.close();
  });
});
