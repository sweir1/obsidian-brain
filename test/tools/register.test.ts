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
});
