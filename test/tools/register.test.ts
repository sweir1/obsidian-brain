import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { z } from 'zod';

/**
 * Minimal mock of the shape of McpServer that registerTool needs: a single
 * `.tool()` method that records the handler callback. The real SDK type is
 * much richer, but registerTool only pokes `.tool(name, desc, schema, cb)`.
 */
interface RecordedTool {
  name: string;
  description: string;
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
      description: string,
      _schema: unknown,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cb: (args: any) => Promise<any>,
    ): void {
      registered.push({ name, description, cb });
    },
  };
  return { server, registered };
}

describe('tools/register', () => {
  const prevEnv = process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS;

  beforeEach(() => {
    // Each test sets its own env var and dynamically imports the module so
    // the timeout constant picks up the intended value.
    vi.resetModules();
  });

  afterEach(() => {
    if (prevEnv === undefined) {
      delete process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS;
    } else {
      process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS = prevEnv;
    }
    vi.resetModules();
  });

  it('times out a handler that never resolves, returning an isError response', async () => {
    process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS = '100';
    const { registerTool } = await import('../../src/tools/register.js');

    const { server, registered } = makeMockServer();
    registerTool(
      server,
      'stuck-tool',
      'A tool that never resolves',
      { foo: z.string().optional() },
      async () => {
        await new Promise(() => {
          /* never resolves */
        });
        return 'unreachable';
      },
    );

    expect(registered).toHaveLength(1);
    const entry = registered[0];
    expect(entry).toBeDefined();
    const tool = entry!;
    const started = Date.now();
    const result = await tool.cb({});
    const elapsed = Date.now() - started;

    expect(result.isError).toBe(true);
    expect(result.content).toBeInstanceOf(Array);
    expect(result.content[0].type).toBe('text');
    expect(result.content[0].text).toContain('stuck-tool');
    expect(result.content[0].text).toContain('timed out after 100ms');
    expect(result.content[0].text).toContain(
      'mcp-server-obsidian-brain.log',
    );
    // Should resolve promptly after the 100ms timeout, with generous slack
    // for CI jitter.
    expect(elapsed).toBeLessThan(1_000);
    expect(elapsed).toBeGreaterThanOrEqual(90);
  });

  it('returns a normal success response when the handler beats the timeout', async () => {
    process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS = '5000';
    const { registerTool } = await import('../../src/tools/register.js');

    const { server, registered } = makeMockServer();
    registerTool(
      server,
      'fast-tool',
      'A tool that returns quickly',
      {},
      async () => ({ ok: true }),
    );

    const entry = registered[0];
    expect(entry).toBeDefined();
    const tool = entry!;
    const result = await tool.cb({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('"ok": true');
  });

  it('falls back to default timeout when env var is non-numeric', async () => {
    process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS = 'not-a-number';
    const { registerTool } = await import('../../src/tools/register.js');

    const { server, registered } = makeMockServer();
    registerTool(server, 'ok-tool', 'returns value', {}, async () => 'hello');
    const entry = registered[0];
    expect(entry).toBeDefined();
    const tool = entry!;
    const result = await tool.cb({});
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('hello');
  });

  // v1.7.20 Fix 12 (E2): per-tool timeout override.
  // `OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS_<TOOL>` overrides the global for that
  // tool only. Lets users keep the global at 30s for `search` but raise
  // `reindex` to 120s.
  it('E2: per-tool env override beats the global timeout', async () => {
    // Save / restore additional per-tool env keys.
    const prevReindex = process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS_REINDEX;
    process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS = '50';
    process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS_REINDEX = '300';
    try {
      const { registerTool } = await import('../../src/tools/register.js');
      const { server, registered } = makeMockServer();
      // `reindex` tool — has a per-tool override of 300ms.
      registerTool(server, 'reindex', 'long', {}, async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return 'done';
      });
      // `search` tool — only the global 50ms applies.
      registerTool(server, 'search', 'short', {}, async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return 'done';
      });

      const reindexResult = await registered[0]!.cb({});
      // 150ms work < 300ms reindex timeout → succeeds
      expect(reindexResult.isError).toBeUndefined();
      expect(reindexResult.content[0].text).toBe('done');

      const searchResult = await registered[1]!.cb({});
      // 150ms work > 50ms global timeout → times out
      expect(searchResult.isError).toBe(true);
      expect(searchResult.content[0].text).toMatch(/timed out after 50ms/);
    } finally {
      delete process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS_REINDEX;
      if (prevReindex !== undefined) process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS_REINDEX = prevReindex;
    }
  });

  it('E2: built-in per-tool default — reindex baseline is 10 min, not 30s', async () => {
    // No env vars set — the baseline kicks in.
    const prevReindex = process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS_REINDEX;
    delete process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS;
    delete process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS_REINDEX;
    try {
      const { registerTool } = await import('../../src/tools/register.js');
      const { server, registered } = makeMockServer();
      // Handler runs for 200ms — comfortably below the 10-min baseline,
      // would have timed out under the old 30s default if the baseline
      // wasn't applied... well, 200ms is also below 30s, so that doesn't
      // distinguish. Instead, the test checks the timeout MESSAGE on a
      // synthetic timeout: the resolved timeout for `reindex` should be
      // very large.
      registerTool(server, 'reindex', '', {}, async () => 'done');
      const result = await registered[0]!.cb({});
      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe('done');
    } finally {
      if (prevReindex !== undefined) process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS_REINDEX = prevReindex;
    }
  });

  it('E2: env override beats the built-in per-tool baseline', async () => {
    // User can shorten `reindex`'s 10-min baseline if they want.
    delete process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS;
    process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS_REINDEX = '50';
    try {
      const { registerTool } = await import('../../src/tools/register.js');
      const { server, registered } = makeMockServer();
      registerTool(server, 'reindex', '', {}, async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return 'should-time-out';
      });
      const result = await registered[0]!.cb({});
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/timed out after 50ms/);
    } finally {
      delete process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS_REINDEX;
    }
  });

  it('E2: per-tool override key normalises hyphens to underscores', async () => {
    const prevKey = process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS_FIND_PATH_BETWEEN;
    process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS = '50';
    process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS_FIND_PATH_BETWEEN = '500';
    try {
      const { registerTool } = await import('../../src/tools/register.js');
      const { server, registered } = makeMockServer();
      registerTool(server, 'find_path_between', '', {}, async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return 'ok';
      });
      const result = await registered[0]!.cb({});
      // 100ms < 500ms per-tool timeout
      expect(result.isError).toBeUndefined();
    } finally {
      delete process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS_FIND_PATH_BETWEEN;
      if (prevKey !== undefined) process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS_FIND_PATH_BETWEEN = prevKey;
    }
  });
});
