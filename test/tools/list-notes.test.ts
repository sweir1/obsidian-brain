import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { upsertNode } from '../../src/store/nodes.js';
import { registerListNotesTool } from '../../src/tools/list-notes.js';
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

describe('tools/list_notes', () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDb(':memory:');
    // Three directories + one stub + one untagged leaf so every filter path
    // has something to distinguish it.
    upsertNode(db, {
      id: 'People/Alice.md',
      title: 'Alice',
      content: '',
      frontmatter: { tags: ['friend', 'researcher'] },
    });
    upsertNode(db, {
      id: 'People/Bob.md',
      title: 'Bob',
      content: '',
      frontmatter: { tags: ['friend'] },
    });
    upsertNode(db, {
      id: 'Concepts/Widget.md',
      title: 'Widget',
      content: '',
      frontmatter: { tags: ['idea'] },
    });
    upsertNode(db, {
      id: 'orphan.md',
      title: 'Orphan',
      content: '',
      frontmatter: {},
    });
    upsertNode(db, {
      id: '_stub/Missing.md',
      title: 'Missing',
      content: '',
      frontmatter: { _stub: true, tags: ['idea'] },
    });
  });

  afterEach(() => db.close());

  it('returns every non-stub node by default', async () => {
    const { server, registered } = makeMockServer();
    registerListNotesTool(server, { db } as ServerContext);
    const out = unwrap(await registered[0].cb({}));
    const ids = out.map((r: { id: string }) => r.id);
    expect(ids).toContain('People/Alice.md');
    expect(ids).toContain('People/Bob.md');
    expect(ids).toContain('Concepts/Widget.md');
    expect(ids).toContain('orphan.md');
    // Default `includeStubs` is unset (truthy-by-absence), so the stub DOES
    // appear by default — only the explicit `false` excludes it.
    expect(ids).toContain('_stub/Missing.md');
  });

  it('directory filter restricts to a subdir prefix', async () => {
    const { server, registered } = makeMockServer();
    registerListNotesTool(server, { db } as ServerContext);
    const out = unwrap(await registered[0].cb({ directory: 'People' }));
    const ids = out.map((r: { id: string }) => r.id);
    expect(ids).toEqual(expect.arrayContaining(['People/Alice.md', 'People/Bob.md']));
    expect(ids).not.toContain('Concepts/Widget.md');
    expect(ids).not.toContain('orphan.md');
  });

  it('tag filter returns only notes with that frontmatter tag', async () => {
    const { server, registered } = makeMockServer();
    registerListNotesTool(server, { db } as ServerContext);
    const out = unwrap(await registered[0].cb({ tag: 'idea' }));
    const ids = out.map((r: { id: string }) => r.id);
    expect(ids).toContain('Concepts/Widget.md');
    expect(ids).toContain('_stub/Missing.md');
    expect(ids).not.toContain('People/Alice.md');
  });

  it('includeStubs: false excludes stub-flagged notes', async () => {
    const { server, registered } = makeMockServer();
    registerListNotesTool(server, { db } as ServerContext);
    const out = unwrap(await registered[0].cb({ includeStubs: false }));
    const ids = out.map((r: { id: string }) => r.id);
    expect(ids).not.toContain('_stub/Missing.md');
    expect(ids).toContain('People/Alice.md');
  });

  it('limit caps the number of results', async () => {
    const { server, registered } = makeMockServer();
    registerListNotesTool(server, { db } as ServerContext);
    const out = unwrap(await registered[0].cb({ limit: 2 }));
    expect(out.length).toBe(2);
  });

  it('notes with non-array or missing `tags` report an empty tags array', async () => {
    const { server, registered } = makeMockServer();
    registerListNotesTool(server, { db } as ServerContext);
    const out = unwrap(await registered[0].cb({}));
    const orphan = out.find((r: { id: string }) => r.id === 'orphan.md')!;
    expect(orphan.tags).toEqual([]);
  });

  it('combined directory + tag filter intersects both', async () => {
    const { server, registered } = makeMockServer();
    registerListNotesTool(server, { db } as ServerContext);
    const out = unwrap(await registered[0].cb({ directory: 'People', tag: 'researcher' }));
    const ids = out.map((r: { id: string }) => r.id);
    expect(ids).toEqual(['People/Alice.md']);
  });
});
