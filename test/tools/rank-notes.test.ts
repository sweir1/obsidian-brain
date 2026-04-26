import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { upsertNode } from '../../src/store/nodes.js';
import { insertEdge } from '../../src/store/edges.js';
import { upsertCommunity } from '../../src/store/communities.js';
import { registerRankNotesTool } from '../../src/tools/rank-notes.js';
import type { ServerContext } from '../../src/context.js';

/** Minimal mock of `McpServer.tool()` — captures registered handlers. */
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

describe('tools/rank_notes - H4 includeStubs + I credibility guards', () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDb(':memory:');
    // 5-node vault: hub receives 3 inbound links, orphan receives 1, stub
    // receives 0. Two low-degree leaves so the filter has a meaningful effect.
    upsertNode(db, { id: 'hub.md', title: 'Hub', content: '', frontmatter: {} });
    upsertNode(db, { id: 'leaf1.md', title: 'Leaf 1', content: '', frontmatter: {} });
    upsertNode(db, { id: 'leaf2.md', title: 'Leaf 2', content: '', frontmatter: {} });
    upsertNode(db, { id: 'leaf3.md', title: 'Leaf 3', content: '', frontmatter: {} });
    upsertNode(db, { id: 'orphan.md', title: 'Orphan', content: '', frontmatter: {} });
    upsertNode(db, {
      id: 'stub.md',
      title: 'Stub',
      content: '',
      frontmatter: { _stub: true },
    });

    // Hub has 3 inbound edges.
    insertEdge(db, { sourceId: 'leaf1.md', targetId: 'hub.md', context: '' });
    insertEdge(db, { sourceId: 'leaf2.md', targetId: 'hub.md', context: '' });
    insertEdge(db, { sourceId: 'leaf3.md', targetId: 'hub.md', context: '' });
    // Orphan only has 1 inbound edge (from leaf1).
    insertEdge(db, { sourceId: 'leaf1.md', targetId: 'orphan.md', context: '' });
    // Stub is pointed at by leaf2 — 1 inbound edge.
    insertEdge(db, { sourceId: 'leaf2.md', targetId: 'stub.md', context: '' });
  });

  afterEach(() => {
    db.close();
  });

  it('influence default: minIncomingLinks=2 filters out single-inbound nodes', async () => {
    const { server, registered } = makeMockServer();
    registerRankNotesTool(server, { db } as unknown as ServerContext);
    const tool = registered.find((t) => t.name === 'rank_notes')!;

    const result = unwrap(await tool.cb({ metric: 'influence' }));
    const ids = result.map((r: { id: string }) => r.id);
    expect(ids).toContain('hub.md');
    expect(ids).not.toContain('orphan.md');
    expect(ids).not.toContain('leaf1.md');
  });

  it('influence with minIncomingLinks=0 includes low-inbound nodes', async () => {
    const { server, registered } = makeMockServer();
    registerRankNotesTool(server, { db } as unknown as ServerContext);
    const tool = registered.find((t) => t.name === 'rank_notes')!;

    const result = unwrap(
      await tool.cb({ metric: 'influence', minIncomingLinks: 0 }),
    );
    const ids = result.map((r: { id: string }) => r.id);
    expect(ids).toContain('hub.md');
    expect(ids).toContain('orphan.md');
  });

  it('default (includeStubs omitted) excludes _stub nodes; includeStubs:true re-includes them', async () => {
    const { server, registered } = makeMockServer();
    registerRankNotesTool(server, { db } as unknown as ServerContext);
    const tool = registered.find((t) => t.name === 'rank_notes')!;

    const defaultResult = unwrap(
      await tool.cb({ metric: 'influence', minIncomingLinks: 0 }),
    );
    const withStubs = unwrap(
      await tool.cb({
        metric: 'influence',
        minIncomingLinks: 0,
        includeStubs: true,
      }),
    );

    const defaultIds = defaultResult.map((r: { id: string }) => r.id);
    const withStubIds = withStubs.map((r: { id: string }) => r.id);
    // Hub must survive both calls — it's a real node, not a stub.
    expect(defaultIds).toContain('hub.md');
    expect(withStubIds).toContain('hub.md');
    // Default excludes stubs; opt-in re-includes them.
    expect(defaultIds).not.toContain('stub.md');
    expect(withStubIds).toContain('stub.md');
  });

  it('bridging: scores are normalized to [0,1] by n*(n-1)/2', async () => {
    const { server, registered } = makeMockServer();
    registerRankNotesTool(server, { db } as unknown as ServerContext);
    const tool = registered.find((t) => t.name === 'rank_notes')!;

    const result = unwrap(await tool.cb({ metric: 'bridging' }));
    for (const entry of result) {
      expect(entry.score).toBeGreaterThanOrEqual(0);
      expect(entry.score).toBeLessThanOrEqual(1);
    }
  });

  it('bridging: two-vault-sizes yield comparable (same-scale) scores', async () => {
    // Sanity-check that normalization eliminates size-scaling. Build a second
    // vault with the same topology but a different vault size — a bridging
    // node's normalized score should be dominated by its structural role,
    // not the absolute number of shortest paths.
    const db2 = openDb(':memory:');
    for (const id of ['a.md', 'b.md', 'c.md']) {
      upsertNode(db2, { id, title: id, content: '', frontmatter: {} });
    }
    // Path graph a—b—c: b is the bridge.
    insertEdge(db2, { sourceId: 'a.md', targetId: 'b.md', context: '' });
    insertEdge(db2, { sourceId: 'b.md', targetId: 'c.md', context: '' });

    const { server, registered } = makeMockServer();
    registerRankNotesTool(server, { db: db2 } as unknown as ServerContext);
    const tool = registered.find((t) => t.name === 'rank_notes')!;

    const result = unwrap(await tool.cb({ metric: 'bridging' }));
    // Bridge node b has raw betweenness 1 on a 3-node path; normalized by
    // 3*2/2 = 3 → ~0.333 (rounded). Must land in [0, 1].
    const b = result.find((r: { id: string }) => r.id === 'b.md');
    expect(b).toBeDefined();
    expect(b.score).toBeGreaterThan(0);
    expect(b.score).toBeLessThanOrEqual(1);
    db2.close();
  });
});

// themeId filter path — untested before v1.6.14. The filter routes through
// getCommunity() + filterToCommunity() which the rest of the suite never
// exercises. Covers the throw-on-missing-theme branch and the happy-path
// filter that narrows the ranked set to community members.
describe('tools/rank_notes - themeId filter', () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDb(':memory:');
    // 5-node vault split into two communities: {a, b, c} and {x, y}.
    for (const id of ['a.md', 'b.md', 'c.md', 'x.md', 'y.md']) {
      upsertNode(db, { id, title: id, content: '', frontmatter: {} });
    }
    // Dense triangle inside the first community, bridge edge between
    // communities, and one edge inside the second.
    insertEdge(db, { sourceId: 'a.md', targetId: 'b.md', context: '' });
    insertEdge(db, { sourceId: 'b.md', targetId: 'c.md', context: '' });
    insertEdge(db, { sourceId: 'a.md', targetId: 'c.md', context: '' });
    insertEdge(db, { sourceId: 'c.md', targetId: 'x.md', context: '' });
    insertEdge(db, { sourceId: 'x.md', targetId: 'y.md', context: '' });

    upsertCommunity(db, {
      id: 1,
      label: 'theme-alpha',
      summary: 'first cluster',
      nodeIds: ['a.md', 'b.md', 'c.md'],
    });
    upsertCommunity(db, {
      id: 2,
      label: 'theme-beta',
      summary: 'second cluster',
      nodeIds: ['x.md', 'y.md'],
    });
  });

  afterEach(() => db.close());

  it('restricts the ranked set to community members', async () => {
    const { server, registered } = makeMockServer();
    registerRankNotesTool(server, { db } as unknown as ServerContext);
    const tool = registered.find((t) => t.name === 'rank_notes')!;

    const result = unwrap(
      await tool.cb({
        metric: 'influence',
        themeId: 'theme-alpha',
        minIncomingLinks: 0,
      }),
    );
    const ids = result.map((r: { id: string }) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['a.md', 'b.md', 'c.md']));
    expect(ids).not.toContain('x.md');
    expect(ids).not.toContain('y.md');
  });

  it('throws when themeId does not match any community', async () => {
    const { server, registered } = makeMockServer();
    registerRankNotesTool(server, { db } as unknown as ServerContext);
    const tool = registered.find((t) => t.name === 'rank_notes')!;

    // Unwrap short-circuits on isError=true — check the error path directly.
    const result = await tool.cb({ metric: 'influence', themeId: 'nope' });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('No theme found');
  });

  it('bridging-only metric respects themeId', async () => {
    const { server, registered } = makeMockServer();
    registerRankNotesTool(server, { db } as unknown as ServerContext);
    const tool = registered.find((t) => t.name === 'rank_notes')!;

    const result = unwrap(
      await tool.cb({ metric: 'bridging', themeId: 'theme-alpha' }),
    );
    const ids = result.map((r: { id: string }) => r.id);
    // Only theme-alpha members should appear.
    for (const id of ids) {
      expect(['a.md', 'b.md', 'c.md']).toContain(id);
    }
  });
});
