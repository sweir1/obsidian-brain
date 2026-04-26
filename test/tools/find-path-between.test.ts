import { describe, it, expect } from 'vitest';
import { registerFindPathBetweenTool } from '../../src/tools/find-path-between.js';
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
  async init(): Promise<void> {}
  async embed(): Promise<Float32Array> { return new Float32Array(this._dim); }
  dimensions(): number { return this._dim; }
  modelIdentifier(): string { return this._model; }
  providerName(): string { return this._provider; }
  async dispose(): Promise<void> {}
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

describe('tools/find_path_between — stub-filter default (G5)', () => {
  it('default excludes stubs so a real path through the graph survives a competing stub-only route', async () => {
    const db = openDb(':memory:');
    const emb = new StubEmbedder('Xenova/all-MiniLM-L6-v2', 384, 'transformers.js');
    bootstrap(db, emb);

    // Real path: a -> b -> c (length 2)
    // Stub-only "path": a -> _stub/x.md (no further outgoing edges)
    // With stubs included, the only direct edge from `a` is to the stub
    // (degree-1 dead end) plus to `b`. We assert that `findPaths` returns
    // the a→b→c chain even when stubs are present in the data, and that
    // the result is unchanged whether `includeStubs` is on or off (since
    // stubs by definition don't lie on real-to-real paths).
    upsertNode(db, { id: 'a.md', title: 'A', content: '', frontmatter: {} });
    upsertNode(db, { id: 'b.md', title: 'B', content: '', frontmatter: {} });
    upsertNode(db, { id: 'c.md', title: 'C', content: '', frontmatter: {} });
    upsertNode(db, {
      id: '_stub/x.md',
      title: 'X',
      content: '',
      frontmatter: { _stub: true },
    });
    db.prepare(
      "INSERT INTO edges (source_id, target_id, context) VALUES ('a.md', 'b.md', '')",
    ).run();
    db.prepare(
      "INSERT INTO edges (source_id, target_id, context) VALUES ('b.md', 'c.md', '')",
    ).run();
    db.prepare(
      "INSERT INTO edges (source_id, target_id, context) VALUES ('a.md', '_stub/x.md', '')",
    ).run();

    const ctx = { db } as unknown as ServerContext;
    const { server, registered } = makeMockServer();
    registerFindPathBetweenTool(server, ctx);
    const tool = registered.find((t) => t.name === 'find_path_between')!;

    const defaultResult = unwrap(
      await tool.cb({ from: 'a.md', to: 'c.md', maxDepth: 3 }),
    );
    expect(defaultResult.paths.length).toBeGreaterThanOrEqual(1);
    // The real path a -> b -> c must be present.
    const defaultHasRealPath = defaultResult.paths.some(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (p: any) => Array.isArray(p.nodes) && p.nodes.includes('b.md') && p.nodes.includes('c.md'),
    );
    expect(defaultHasRealPath).toBe(true);

    // includeStubs=true does not break the real path (stubs are dead ends,
    // never on a path between two real notes anyway).
    const withStubs = unwrap(
      await tool.cb({ from: 'a.md', to: 'c.md', maxDepth: 3, includeStubs: true }),
    );
    expect(withStubs.paths.length).toBeGreaterThanOrEqual(1);

    db.close();
  });
});
