import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod';

type InferShape<Shape extends z.ZodRawShape> = z.infer<z.ZodObject<Shape>>;

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/**
 * Per-tool-call timeout in milliseconds. Configurable via
 * `OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS`. Falls back to 30s if the env var is
 * unset, non-numeric, or non-positive.
 */
function resolveToolTimeoutMs(): number {
  const raw = process.env.OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS;
  if (raw === undefined) return DEFAULT_TOOL_TIMEOUT_MS;
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) return DEFAULT_TOOL_TIMEOUT_MS;
  return parsed;
}

const TOOL_TIMEOUT_MS = resolveToolTimeoutMs();

/**
 * Register an MCP tool with a Zod input schema + a handler that returns any
 * JSON-serializable result. The helper:
 *   - wraps the result in the MCP `content` format
 *   - catches exceptions and returns `isError: true` responses
 *   - JSON-stringifies objects (and leaves strings untouched)
 *   - enforces a per-call timeout (see `OBSIDIAN_BRAIN_TOOL_TIMEOUT_MS`) so a
 *     stuck background op (embedder, file lock, index lookup) surfaces as a
 *     diagnosable error instead of a silent hang
 *
 * Use `z.record(z.string(), z.unknown())` for open-ended map params — single-arg
 * `z.record` breaks tools/list under Zod v4 ("_zod" error).
 *
 * v1.5.0 — `next_actions` envelope: handlers may opt in by returning
 * `{ data, context: { state, next_actions } }` (see `./hints.ts`). The shape
 * passes through JSON.stringify unchanged; clients parsing the JSON see
 * `context.next_actions` and can route the agent's next call without asking.
 * Non-opting handlers keep returning bare values — backwards compat preserved.
 */
export function registerTool<Shape extends z.ZodRawShape>(
  server: McpServer,
  name: string,
  description: string,
  schema: Shape,
  handler: (args: InferShape<Shape>) => Promise<unknown>,
): void {
  // The MCP SDK's callback type is narrower than what we return from the
  // try/catch branches; cast on the way in to keep the caller API clean.
  const cb = async (args: InferShape<Shape>) => {
    const timeoutMs = TOOL_TIMEOUT_MS;
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<{ __timedOut: true }>((resolve) => {
      timeoutHandle = setTimeout(() => resolve({ __timedOut: true }), timeoutMs);
    });
    try {
      const handlerPromise = handler(args);
      // Swallow late rejections from the background handler so they don't
      // surface as unhandled promise rejections after the timeout wins.
      handlerPromise.catch(() => undefined);
      const raced = await Promise.race([handlerPromise, timeoutPromise]);
      if (
        raced !== null &&
        typeof raced === 'object' &&
        '__timedOut' in raced &&
        (raced as { __timedOut: boolean }).__timedOut === true
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Tool "${name}" timed out after ${timeoutMs}ms. ` +
                `This usually means a background operation (embedder, file lock, or index lookup) is stuck. ` +
                `Check the server log at ~/Library/Logs/Claude/mcp-server-obsidian-brain.log (macOS) for details.`,
            },
          ],
          isError: true,
        };
      }
      const result = raced;
      const text =
        typeof result === 'string' ? result : JSON.stringify(result, null, 2);
      return { content: [{ type: 'text' as const, text }] };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text' as const, text: `Error: ${message}` }],
        isError: true,
      };
    } finally {
      if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    }
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (server as any).tool(name, description, schema, cb);
}
