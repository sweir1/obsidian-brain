import { describe, it, expect } from 'vitest';
import { registerSearchTool } from '../../src/tools/search.js';
import type { ServerContext } from '../../src/context.js';

/**
 * Minimal mock of `McpServer.tool()` — captures registered handlers.
 * Mirrors the pattern used by other tool tests in this suite.
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
  return JSON.parse(result.content[0].text);
}

/**
 * Build a minimal ServerContext stub for testing the embedder-guard path.
 * The `search` stubs return empty arrays so the happy-path tests pass without
 * a real database or embedder.
 */
function makeStubContext({
  embedderReady,
  initError,
}: {
  embedderReady: boolean;
  initError?: unknown;
}): ServerContext {
  return {
    embedderReady: () => embedderReady,
    initError,
    ensureEmbedderReady: async () => undefined,
    search: {
      fulltext: () => [],
      semantic: async () => [],
      semanticChunks: async () => [],
      hybrid: async () => [],
    },
    // The rest of ServerContext is not exercised by these tests.
  } as unknown as ServerContext;
}

describe('tools/search — embedder not-ready guard (Fix B)', () => {
  it('returns {status:"preparing"} for semantic mode when embedder is not ready', async () => {
    const ctx = makeStubContext({ embedderReady: false, initError: undefined });
    const { server, registered } = makeMockServer();
    registerSearchTool(server, ctx);
    const tool = registered.find((t) => t.name === 'search')!;

    const result = unwrap(await tool.cb({ query: 'test', mode: 'semantic' }));
    expect(result.status).toBe('preparing');
    expect(result.message).toMatch(/still downloading/i);
    expect(result.message).toMatch(/fulltext/i);
  });

  it('returns {status:"preparing"} for hybrid mode when embedder is not ready', async () => {
    const ctx = makeStubContext({ embedderReady: false, initError: undefined });
    const { server, registered } = makeMockServer();
    registerSearchTool(server, ctx);
    const tool = registered.find((t) => t.name === 'search')!;

    const result = unwrap(await tool.cb({ query: 'test', mode: 'hybrid' }));
    expect(result.status).toBe('preparing');
    expect(result.message).toMatch(/still downloading/i);
  });

  it('returns {status:"preparing"} for default mode (hybrid) when embedder is not ready', async () => {
    const ctx = makeStubContext({ embedderReady: false, initError: undefined });
    const { server, registered } = makeMockServer();
    registerSearchTool(server, ctx);
    const tool = registered.find((t) => t.name === 'search')!;

    // No mode supplied — defaults to hybrid, which needs the embedder.
    const result = unwrap(await tool.cb({ query: 'test' }));
    expect(result.status).toBe('preparing');
  });

  it('returns {status:"failed"} when initError is set', async () => {
    const initError = new Error('model checksum mismatch');
    const ctx = makeStubContext({ embedderReady: false, initError });
    const { server, registered } = makeMockServer();
    registerSearchTool(server, ctx);
    const tool = registered.find((t) => t.name === 'search')!;

    const result = unwrap(await tool.cb({ query: 'test', mode: 'semantic' }));
    expect(result.status).toBe('failed');
    expect(result.message).toContain('model checksum mismatch');
    expect(result.message).toMatch(/restart the mcp server/i);
    expect(result.message).toMatch(/obsidian-brain models check/i);
  });

  it('failed message includes initError string for non-Error thrown values', async () => {
    const ctx = makeStubContext({ embedderReady: false, initError: 'ENOENT: file not found' });
    const { server, registered } = makeMockServer();
    registerSearchTool(server, ctx);
    const tool = registered.find((t) => t.name === 'search')!;

    const result = unwrap(await tool.cb({ query: 'test', mode: 'hybrid' }));
    expect(result.status).toBe('failed');
    expect(result.message).toContain('ENOENT: file not found');
  });

  it('fulltext mode is unaffected by embedder not-ready state', async () => {
    const ctx = makeStubContext({ embedderReady: false, initError: undefined });
    const { server, registered } = makeMockServer();
    registerSearchTool(server, ctx);
    const tool = registered.find((t) => t.name === 'search')!;

    // Should NOT return preparing — fulltext does not need the embedder.
    const result = unwrap(await tool.cb({ query: 'test', mode: 'fulltext' }));
    // The happy-path returns {data, context} — not a status envelope.
    expect(result).not.toHaveProperty('status');
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('context');
  });

  it('semantic mode proceeds normally when embedder is ready', async () => {
    const ctx = makeStubContext({ embedderReady: true, initError: undefined });
    const { server, registered } = makeMockServer();
    registerSearchTool(server, ctx);
    const tool = registered.find((t) => t.name === 'search')!;

    const result = unwrap(await tool.cb({ query: 'test', mode: 'semantic' }));
    expect(result).not.toHaveProperty('status');
    expect(result).toHaveProperty('data');
    expect(result).toHaveProperty('context');
  });
});
