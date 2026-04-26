/**
 * Synchronous stderr debug logger gated on `OBSIDIAN_BRAIN_DEBUG=1`.
 *
 * **Why sync:** debug logs are most useful right BEFORE a crash — that's
 * when you need to know "what was the last thing the server did?". Async
 * `process.stderr.write` can lose those bytes if the process exits
 * before Node's event loop pumps the buffer (the same race v1.7.7
 * documented for our explicit catch handlers and v1.7.11 documents for
 * Node's default unhandled-rejection handler). `fs.writeSync(2, …)`
 * issues the OS write() syscall directly and blocks until the bytes
 * land in the pipe, so the LAST debug line before a crash always reaches
 * the MCP client's stderr log.
 *
 * **Why this module:** centralising the gate + format means we don't
 * have to repeat the `if (process.env.OBSIDIAN_BRAIN_DEBUG === '1')`
 * check at every call site, and adding a new debug line costs one import
 * + one line — keeping the discipline cheap.
 *
 * **How to enable** (Claude Desktop or any MCP client config):
 * ```json
 * "env": { "OBSIDIAN_BRAIN_DEBUG": "1", "VAULT_PATH": "..." }
 * ```
 * Output appears in `~/Library/Logs/Claude/mcp-server-obsidian-brain.log`
 * on macOS, prefixed with `obsidian-brain debug:`.
 */
import { writeSync } from 'node:fs';

const DEBUG_ENABLED = process.env.OBSIDIAN_BRAIN_DEBUG === '1';

/**
 * Write `msg` to fd 2 with the `obsidian-brain debug:` prefix and a
 * monotonic millisecond timestamp (seconds since process start). No-op
 * when `OBSIDIAN_BRAIN_DEBUG` is not exactly `"1"` — explicit-truthy
 * check, NOT JS truthiness, so accidental `OBSIDIAN_BRAIN_DEBUG=`
 * (empty string, falsy) doesn't enable.
 *
 * Failures swallowed: fd 2 might be closed in some embed-host scenarios
 * we haven't anticipated. Debug log silently dropping is preferable to
 * the debug log itself crashing the process.
 */
export function debugLog(msg: string): void {
  if (!DEBUG_ENABLED) return;
  const elapsedMs = Math.round(process.uptime() * 1000);
  try {
    writeSync(2, `obsidian-brain debug [+${elapsedMs}ms]: ${msg}\n`);
  } catch {
    /* fd 2 closed — drop silently */
  }
}

/** Exported so tests can verify the gate without monkey-patching env. */
export function isDebugEnabled(): boolean {
  return DEBUG_ENABLED;
}
