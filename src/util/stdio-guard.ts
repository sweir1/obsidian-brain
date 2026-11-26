/**
 * Keeps a closed stdio pipe from crashing the process.
 *
 * **The failure mode.** When an MCP client goes away (quits, restarts the
 * server, or a short-lived health probe like `claude mcp list` disconnects
 * after the handshake) it closes the read ends of our stdout/stderr pipes.
 * The next write we make — usually an informational `logger.info(...)` line
 * from the background init block — fails with `EPIPE`. Node reports a failed
 * stream write as an `'error'` event on the stream, and an `'error'` event
 * with no listener is rethrown as an uncaught exception. That landed in
 * `src/global-handlers.ts`, which records a crash to
 * `~/.cache/obsidian-brain/last-startup-error.log` and exits 1 — so a normal
 * client disconnect looked like a server crash, and the crash log pointed
 * users at the logger as if it were writing to the wrong stream (it writes
 * to stderr; the problem was the missing `'error'` listener).
 *
 * **What this module does.**
 *
 *   - stderr: every error is swallowed. stderr only carries diagnostics; if
 *     nobody is reading it there is nothing useful left to do with the
 *     bytes, and there is no other channel to report the failure on.
 *
 *   - stdout: in `server` mode stdout IS the MCP transport. Losing it means
 *     the client is gone, so the right response is the server's normal
 *     graceful shutdown (drain the watcher, close the DB, exit 0) — not a
 *     crash dump. `startServer()` registers that via
 *     `setStdoutLostHandler()`. Outside server mode (CLI subcommands that
 *     print JSON, e.g. `obsidian-brain search ... | head -1`), a broken pipe
 *     is ignored: the command finishes its work and exits normally, which
 *     keeps a reindex from being cut short by a closed reader. Any other
 *     stdout error with no handler registered is rethrown so it still
 *     reaches the global uncaught-exception net unchanged.
 *
 * Installation is idempotent per stream (a marker symbol on the stream
 * object, so it also survives module re-evaluation in tests).
 */

/**
 * Error codes that mean "the reader on the other end of this pipe is gone".
 * `EPIPE` is the POSIX and Windows (libuv-mapped) code; `ECONNRESET` / `EOF`
 * show up on Windows named pipes; the `ERR_STREAM_*` codes are what Node
 * reports for writes attempted after the stream was already torn down by
 * the first failure.
 */
const BROKEN_PIPE_CODES: ReadonlySet<string> = new Set([
  'EPIPE',
  'ECONNRESET',
  'EOF',
  'ERR_STREAM_DESTROYED',
  'ERR_STREAM_WRITE_AFTER_END',
]);

const GUARD_MARKER = Symbol.for('obsidian-brain.stdio-guard');

/** Minimal surface of a writable stdio stream that the guard needs. */
export interface GuardableStream {
  on(event: 'error', listener: (err: Error) => void): unknown;
}

export type StdoutLostHandler = (err: Error) => void;

let stdoutLostHandler: StdoutLostHandler | null = null;

/** True when `err` means the reader of the pipe we wrote to has gone away. */
export function isBrokenPipeError(err: unknown): boolean {
  if (err === null || typeof err !== 'object') return false;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' && BROKEN_PIPE_CODES.has(code);
}

/**
 * Register what to do when stdout stops being writable. `startServer()`
 * passes its graceful-shutdown routine. Pass `null` to unregister.
 */
export function setStdoutLostHandler(handler: StdoutLostHandler | null): void {
  stdoutLostHandler = handler;
}

/** `'error'` listener for stderr: diagnostics only, so always swallow. */
export function onStderrError(_err: Error): void {
  /* nothing to do — and no channel left to report on */
}

/** `'error'` listener for stdout. See the module comment for the policy. */
export function onStdoutError(err: Error): void {
  if (stdoutLostHandler) {
    stdoutLostHandler(err);
    return;
  }
  if (isBrokenPipeError(err)) return;
  // Not a closed pipe and nobody claimed it: keep the pre-guard behaviour
  // (surfaces as an uncaught exception → global crash handler).
  throw err;
}

/**
 * Attach the `'error'` listeners. Defaults to the real `process.stdout` /
 * `process.stderr`; tests inject stand-ins. Safe to call more than once.
 */
export function installStdioGuards(
  streams: { stdout?: GuardableStream; stderr?: GuardableStream } = {
    stdout: process.stdout,
    stderr: process.stderr,
  },
): void {
  guard(streams.stderr, onStderrError);
  guard(streams.stdout, onStdoutError);
}

function guard(stream: GuardableStream | undefined, listener: (err: Error) => void): void {
  if (!stream) return;
  const marked = stream as unknown as Record<symbol, unknown>;
  if (marked[GUARD_MARKER]) return;
  marked[GUARD_MARKER] = true;
  stream.on('error', listener);
}

/**
 * Point `console.log` / `console.info` / `console.debug` at stderr.
 *
 * In server mode stdout carries JSON-RPC frames only; a stray
 * `console.log` from a dependency would corrupt the channel. Nothing in
 * obsidian-brain's own server path writes to stdout, so this is a guard
 * against third-party code, not a behaviour change for our own output.
 */
export function routeConsoleToStderr(target: Console = console): void {
  const toStderr = (...args: unknown[]): void => {
    target.error(...args);
  };
  target.log = toStderr;
  target.info = toStderr;
  target.debug = toStderr;
}
