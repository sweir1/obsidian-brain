import { describe, it, expect } from 'vitest';
import { registerReadNoteTool } from '../../src/tools/read-note.js';
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
 * v1.6.9 regression: `read_note` in full mode calls getEdgesBySource /
 * getEdgesByTarget, which SELECT target_fragment. If the migration is
 * missing from bootstrap, a pre-v4 DB throws `no such column`.
 */
describe('tools/read_note — schema migration regression', () => {
  it('full mode succeeds on a DB that was pre-v4 before boot', async () => {
    const db = openDb(':memory:');
    const emb = new StubEmbedder('Xenova/all-MiniLM-L6-v2', 384, 'transformers.js');

    bootstrap(db, emb);
    db.exec('ALTER TABLE edges DROP COLUMN target_fragment');
    db.prepare("UPDATE index_metadata SET value = '3' WHERE key = 'schema_version'").run();

    upsertNode(db, { id: 'a.md', title: 'Alpha', content: 'body', frontmatter: {} });
    upsertNode(db, { id: 'b.md', title: 'Beta', content: 'body', frontmatter: {} });
    db.prepare(
      "INSERT INTO edges (source_id, target_id, context) VALUES ('a.md', 'b.md', 'link')",
    ).run();
    db.prepare(
      "INSERT INTO edges (source_id, target_id, context) VALUES ('b.md', 'a.md', 'backlink')",
    ).run();

    bootstrap(db, emb);

    const ctx = { db } as unknown as ServerContext;
    const { server, registered } = makeMockServer();
    registerReadNoteTool(server, ctx);
    const tool = registered.find((t) => t.name === 'read_note')!;

    const result = unwrap(await tool.cb({ name: 'a.md', mode: 'full' }));
    expect(result.data.id).toBe('a.md');
    expect(result.data.outgoing).toEqual(
      expect.arrayContaining([expect.objectContaining({ targetId: 'b.md' })]),
    );
    expect(result.data.incoming).toEqual(
      expect.arrayContaining([expect.objectContaining({ sourceId: 'b.md' })]),
    );

    db.close();
  });

  it('brief mode also succeeds on a pre-v4 DB (uses getEdgeSummariesBySource/Target, which do not SELECT target_fragment)', async () => {
    const db = openDb(':memory:');
    const emb = new StubEmbedder('Xenova/all-MiniLM-L6-v2', 384, 'transformers.js');

    bootstrap(db, emb);
    db.exec('ALTER TABLE edges DROP COLUMN target_fragment');
    db.prepare("UPDATE index_metadata SET value = '3' WHERE key = 'schema_version'").run();

    upsertNode(db, { id: 'a.md', title: 'Alpha', content: 'body', frontmatter: {} });
    upsertNode(db, { id: 'b.md', title: 'Beta', content: 'body', frontmatter: {} });
    db.prepare(
      "INSERT INTO edges (source_id, target_id, context) VALUES ('a.md', 'b.md', 'link')",
    ).run();

    bootstrap(db, emb);

    const ctx = { db } as unknown as ServerContext;
    const { server, registered } = makeMockServer();
    registerReadNoteTool(server, ctx);
    const tool = registered.find((t) => t.name === 'read_note')!;

    const result = unwrap(await tool.cb({ name: 'a.md' }));
    expect(result.data.id).toBe('a.md');

    db.close();
  });
});
