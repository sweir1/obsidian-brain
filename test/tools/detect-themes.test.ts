import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { upsertNode } from '../../src/store/nodes.js';
import { upsertCommunity } from '../../src/store/communities.js';
import { insertEdge } from '../../src/store/edges.js';
import { registerDetectThemesTool } from '../../src/tools/detect-themes.js';
import type { ServerContext } from '../../src/context.js';

/**
 * Minimal mock of `McpServer.tool()` used by the tool registrar. Captures the
 * handler callback so tests can invoke it directly with args.
 */
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

/**
 * Unwrap the MCP `content` envelope produced by `registerTool`. Returns the
 * parsed JSON body from the single text block.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrap(result: any): any {
  expect(result.isError).toBeFalsy();
  const text = result.content[0].text;
  return JSON.parse(text);
}

describe('tools/detect_themes - A2 read-path consistency', () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('adds staleMembersFiltered: 0 when cache is fresh', async () => {
    upsertNode(db, { id: 'a.md', title: 'A', content: '', frontmatter: {} });
    upsertNode(db, { id: 'b.md', title: 'B', content: '', frontmatter: {} });
    upsertCommunity(db, {
      id: 0,
      label: 'ab',
      summary: 'Key members: A, B. 2 nodes total.',
      nodeIds: ['a.md', 'b.md'],
    });

    const { server, registered } = makeMockServer();
    registerDetectThemesTool(server, { db } as unknown as ServerContext);
    const tool = registered.find((t) => t.name === 'detect_themes')!;

    const payload = unwrap(await tool.cb({}));
    expect(Array.isArray(payload)).toBe(true);
    expect(payload[0].staleMembersFiltered).toBe(0);
    expect(payload[0].nodeIds).toEqual(['a.md', 'b.md']);
    expect(payload[0].summary).toContain('A, B');
  });

  it('filters ghost ids at read time and regenerates summary', async () => {
    // `ghost.md` is named in the cache but never existed as a node — the
    // half-invalidated cache condition the v1.4.0 feedback proved.
    upsertNode(db, { id: 'a.md', title: 'A', content: '', frontmatter: {} });
    upsertCommunity(db, {
      id: 0,
      label: 'a',
      summary: 'Key members: A, Ghost. Tags: ghost-tag. 2 nodes total.',
      nodeIds: ['a.md', 'ghost.md'],
    });

    const { server, registered } = makeMockServer();
    registerDetectThemesTool(server, { db } as unknown as ServerContext);
    const tool = registered.find((t) => t.name === 'detect_themes')!;

    const payload = unwrap(await tool.cb({}));
    const [cluster] = payload;
    expect(cluster.staleMembersFiltered).toBe(1);
    expect(cluster.nodeIds).toEqual(['a.md']);
    expect(cluster.summary).not.toContain('Ghost');
    expect(cluster.summary).not.toContain('ghost-tag');
    expect(cluster.summary).toContain('1 nodes total');
  });

  it('themeId drill-down reconciles the single returned cluster', async () => {
    upsertNode(db, { id: 'a.md', title: 'A', content: '', frontmatter: {} });
    upsertCommunity(db, {
      id: 3,
      label: 'three',
      summary: 'Key members: A, Ghost. 2 nodes total.',
      nodeIds: ['a.md', 'ghost.md'],
    });

    const { server, registered } = makeMockServer();
    registerDetectThemesTool(server, { db } as unknown as ServerContext);
    const tool = registered.find((t) => t.name === 'detect_themes')!;

    const cluster = unwrap(await tool.cb({ themeId: '3' }));
    expect(cluster).not.toBeNull();
    expect(cluster.staleMembersFiltered).toBe(1);
    expect(cluster.nodeIds).toEqual(['a.md']);
    expect(cluster.summary).not.toContain('Ghost');
    expect(cluster.summary).toContain('1 nodes total');
  });
});

describe('tools/detect_themes - H4 includeStubs + I modularity guard', () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('includeStubs: false filters nodes with frontmatter._stub: true', async () => {
    upsertNode(db, { id: 'real.md', title: 'Real', content: '', frontmatter: {} });
    upsertNode(db, {
      id: 'stub.md',
      title: 'Stub',
      content: '',
      frontmatter: { _stub: true },
    });
    upsertCommunity(db, {
      id: 0,
      label: 'mixed',
      summary: 'Key members: Real, Stub. 2 nodes total.',
      nodeIds: ['real.md', 'stub.md'],
    });

    const { server, registered } = makeMockServer();
    registerDetectThemesTool(server, { db } as unknown as ServerContext);
    const tool = registered.find((t) => t.name === 'detect_themes')!;

    const payload = unwrap(await tool.cb({ includeStubs: false }));
    // Bare-array response shape when no modularity warning
    const clusters = Array.isArray(payload) ? payload : payload.clusters;
    expect(clusters[0].nodeIds).toEqual(['real.md']);
    expect(clusters[0].summary).not.toContain('Stub');
  });

  it('default (includeStubs omitted) excludes stub nodes from the membership', async () => {
    upsertNode(db, { id: 'real.md', title: 'Real', content: '', frontmatter: {} });
    upsertNode(db, {
      id: 'stub.md',
      title: 'Stub',
      content: '',
      frontmatter: { _stub: true },
    });
    upsertCommunity(db, {
      id: 0,
      label: 'mixed',
      summary: 'Key members: Real, Stub. 2 nodes total.',
      nodeIds: ['real.md', 'stub.md'],
    });

    const { server, registered } = makeMockServer();
    registerDetectThemesTool(server, { db } as unknown as ServerContext);
    const tool = registered.find((t) => t.name === 'detect_themes')!;

    const payload = unwrap(await tool.cb({}));
    const clusters = Array.isArray(payload) ? payload : payload.clusters;
    expect(clusters[0].nodeIds).toEqual(['real.md']);
  });

  it('includeStubs: true keeps stub nodes in the membership (opt-in)', async () => {
    upsertNode(db, { id: 'real.md', title: 'Real', content: '', frontmatter: {} });
    upsertNode(db, {
      id: 'stub.md',
      title: 'Stub',
      content: '',
      frontmatter: { _stub: true },
    });
    upsertCommunity(db, {
      id: 0,
      label: 'mixed',
      summary: 'Key members: Real, Stub. 2 nodes total.',
      nodeIds: ['real.md', 'stub.md'],
    });

    const { server, registered } = makeMockServer();
    registerDetectThemesTool(server, { db } as unknown as ServerContext);
    const tool = registered.find((t) => t.name === 'detect_themes')!;

    const payload = unwrap(await tool.cb({ includeStubs: true }));
    const clusters = Array.isArray(payload) ? payload : payload.clusters;
    expect(clusters[0].nodeIds).toEqual(['real.md', 'stub.md']);
  });

  it('adds warning + modularity on the envelope when a poor partition fails the 0.3 threshold', async () => {
    // Two cached "clusters" that are actually densely cross-connected — a
    // classic low-modularity case (partition barely improves on random).
    for (let i = 0; i < 4; i++) {
      upsertNode(db, {
        id: `a${i}.md`,
        title: `A${i}`,
        content: '',
        frontmatter: {},
      });
      upsertNode(db, {
        id: `b${i}.md`,
        title: `B${i}`,
        content: '',
        frontmatter: {},
      });
    }
    // Fully-connected bipartite-ish edges between A and B cohorts => modularity
    // of a bipartite-matching "community" split is near zero / negative.
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        insertEdge(db, { sourceId: `a${i}.md`, targetId: `b${j}.md`, context: '' });
      }
    }
    upsertCommunity(db, {
      id: 0,
      label: 'A',
      summary: 'A side',
      nodeIds: ['a0.md', 'a1.md', 'a2.md', 'a3.md'],
    });
    upsertCommunity(db, {
      id: 1,
      label: 'B',
      summary: 'B side',
      nodeIds: ['b0.md', 'b1.md', 'b2.md', 'b3.md'],
    });

    const { server, registered } = makeMockServer();
    registerDetectThemesTool(server, { db } as unknown as ServerContext);
    const tool = registered.find((t) => t.name === 'detect_themes')!;

    const payload = unwrap(await tool.cb({}));
    expect(Array.isArray(payload)).toBe(false);
    expect(payload.warning).toMatch(/modularity/);
    expect(payload.warning).toMatch(/not clearly separable/);
    expect(typeof payload.modularity).toBe('number');
    expect(payload.modularity).toBeLessThan(0.3);
    expect(Array.isArray(payload.clusters)).toBe(true);
    expect(payload.clusters).toHaveLength(2);
  });

  it('G2 v1.7.20: surfaces modularity on every response (not only the warning branch)', async () => {
    // Two disjoint triangles — a textbook high-modularity partition.
    for (const id of ['a1.md', 'a2.md', 'a3.md', 'b1.md', 'b2.md', 'b3.md']) {
      upsertNode(db, { id, title: id, content: '', frontmatter: {} });
    }
    insertEdge(db, { sourceId: 'a1.md', targetId: 'a2.md', context: '' });
    insertEdge(db, { sourceId: 'a2.md', targetId: 'a3.md', context: '' });
    insertEdge(db, { sourceId: 'a3.md', targetId: 'a1.md', context: '' });
    insertEdge(db, { sourceId: 'b1.md', targetId: 'b2.md', context: '' });
    insertEdge(db, { sourceId: 'b2.md', targetId: 'b3.md', context: '' });
    insertEdge(db, { sourceId: 'b3.md', targetId: 'b1.md', context: '' });
    upsertCommunity(db, {
      id: 0,
      label: 'A',
      summary: 'A',
      nodeIds: ['a1.md', 'a2.md', 'a3.md'],
    });
    upsertCommunity(db, {
      id: 1,
      label: 'B',
      summary: 'B',
      nodeIds: ['b1.md', 'b2.md', 'b3.md'],
    });

    const { server, registered } = makeMockServer();
    registerDetectThemesTool(server, { db } as unknown as ServerContext);
    const tool = registered.find((t) => t.name === 'detect_themes')!;

    const payload = unwrap(await tool.cb({}));
    // v1.7.20 G2: modularity always surfaced when computable.
    expect(Array.isArray(payload)).toBe(false);
    expect(typeof payload.modularity).toBe('number');
    expect(payload.modularity).toBeGreaterThanOrEqual(0.3);
    // No warning attached on healthy partitions.
    expect(payload.warning).toBeUndefined();
    expect(Array.isArray(payload.clusters)).toBe(true);
    expect(payload.clusters).toHaveLength(2);
  });
});
