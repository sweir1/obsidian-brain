/**
 * Global error nets — last-resort capture for anything that escapes every
 * other handler.
 *
 * **Why this exists:**
 *
 *   v1.7.7's preflight (src/preflight.ts) closes the silent-crash gap for
 *   one specific failure mode: top-level `import` of native modules
 *   (`better-sqlite3`, `sqlite-vec`) failing before any user-code try/catch
 *   is on the stack. v1.7.7 also added synchronous `fs.writeSync(2, …)`
 *   inside our explicit `parseAsync().catch` handlers in `cli/index.ts`
 *   and `startServer().catch` in `server.ts`, so errors that DO reach
 *   those catches don't race with Node's async stderr buffer on
 *   `process.exit(1)`.
 *
 *   But every async path that doesn't go through one of those catches
 *   was still uncaught:
 *     - chokidar event handlers we forgot to subscribe to
 *     - MCP SDK transport callbacks
 *     - transitive-dep EventEmitter errors
 *     - any `void (async () => …)()` block that throws after its
 *       enclosing try/catch is no longer on the stack
 *     - any `setTimeout`/`setInterval` callback that throws
 *     - any future code path that throws without explicit handling
 *
 *   When one of those threw, Node's DEFAULT handler fired:
 *     - `unhandledRejection` (Node 20+): writes to stderr + terminates
 *       with exit code 1.
 *     - `uncaughtException`: writes to stderr + terminates with code 1.
 *
 *   Both default-handler stderr writes are **asynchronous** and race with
 *   the implicit `process.exit(1)` that follows. On a fast crash the bytes
 *   sit in Node's stream buffer until the process is already gone, and
 *   the MCP client's stderr reader sees an empty pipe with EOF. The crash
 *   is silent — exactly what bit user "Talal" on 2026-04-26 (Node 22.22.2,
 *   ~2.4s from boot to silent exit, no log entry).
 *
 * **What this module does:**
 *
 *   - Registers `process.on('uncaughtException')` and
 *     `process.on('unhandledRejection')` at module-import time. Loaded
 *     immediately after `./preflight.js` in `src/cli/index.ts`, so the
 *     handlers are armed before any user code (commander parsing,
 *     createContext, etc.) runs.
 *
 *   - On either fire: writes the error synchronously to fd 2 via
 *     `fs.writeSync(2, …)` (bypasses Node's async Writable buffer —
 *     bytes always reach the pipe before exit), AND writes the same
 *     content to `~/.cache/obsidian-brain/last-startup-error.log` as
 *     a recoverable record if the MCP client's stderr capture loses
 *     the message anyway.
 *
 *   - Exits 1 explicitly. Default Node behaviour for both events is
 *     terminate-with-1 in v20+; we make it explicit so the exit can't
 *     fire before our sync writes complete.
 *
 *   - Marks the crash with a `type:` line (`uncaught-exception` /
 *     `unhandled-rejection`) so the log file distinguishes these from
 *     the preflight-recorded native-module-load crashes.
 *
 * **What this module does NOT do:**
 *
 *   - Doesn't try to recover. By the time uncaughtException fires, the
 *     process state is already poisoned — continuing risks subtle
 *     corruption (half-flushed writes, stale locks). We log and exit.
 *
 *   - Doesn't change the behaviour for explicitly-caught errors. Code
 *     that already wraps work in try/catch keeps working as before.
 *     This is the LAST-RESORT net, not a substitute for local handling.
 */
import { mkdirSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export type CrashKind = 'uncaught-exception' | 'unhandled-rejection';

/**
 * Synchronously record a crash to fd 2 and to
 * `~/.cache/obsidian-brain/last-startup-error.log`.
 *
 * Both writes are blocking syscalls so the bytes land before the caller
 * issues `process.exit(1)`. Both swallow their own errors via try/catch
 * because the calling context is already a fatal-error path — we don't
 * want a teardown-time write failure to mask the original crash.
 *
 * Exported so tests can verify the file/banner shape without having to
 * trigger a real `process.on('uncaughtException')` event (which would
 * otherwise need a forked-process harness).
 */
export function recordCrash(kind: CrashKind, err: unknown): void {
  const errStack =
    err instanceof Error
      ? `${err.message}\n${err.stack ?? ''}`
      : String(err);
  const label =
    kind === 'uncaught-exception'
      ? 'Uncaught exception'
      : 'Unhandled promise rejection';
  const banner =
    `\nobsidian-brain: ✗ ${label} — process exiting.\n` +
    `  Node:   ${process.version} (NODE_MODULE_VERSION ${process.versions.modules})\n` +
    `  Detail: ~/.cache/obsidian-brain/last-startup-error.log\n\n`;

  // Synchronous fs.writeSync(2, …) — bypasses Node's async stderr buffering
  // so the bytes reach the MCP client's stderr pipe before process.exit.
  try {
    writeSync(2, banner + errStack + '\n');
  } catch {
    /* fd 2 closed somehow — fall through to the log file */
  }

  try {
    const dir = join(homedir(), '.cache', 'obsidian-brain');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'last-startup-error.log'),
      `# obsidian-brain ${kind}\n` +
        `timestamp: ${new Date().toISOString()}\n` +
        `type:      ${kind}\n` +
        `node:      ${process.version}\n` +
        `abi:       ${process.versions.modules}\n` +
        `platform:  ${process.platform}-${process.arch}\n` +
        `\n` +
        errStack +
        '\n',
    );
  } catch {
    /* best-effort — fd 2 path above already covered the must-emit case */
  }
}

/**
 * Named handler for `uncaughtException`. Exported for tests; the
 * registration call below installs this same function on `process`.
 */
export function onUncaughtException(err: Error): void {
  recordCrash('uncaught-exception', err);
  process.exit(1);
}

/**
 * Named handler for `unhandledRejection`. Exported for tests; the
 * registration call below installs this same function on `process`.
 */
export function onUnhandledRejection(reason: unknown): void {
  recordCrash('unhandled-rejection', reason);
  process.exit(1);
}

// ── Side-effect-on-import: register the global nets ─────────────────────
// Loaded after `./preflight.js` in `src/cli/index.ts` so preflight's
// native-module-load crash recording fires first if it's going to fire,
// then these handlers are armed for everything else for the rest of the
// process lifetime. Adding the same function reference twice would be
// a no-op (Node dedupes by function identity), so re-importing this
// module is safe.
process.on('uncaughtException', onUncaughtException);
process.on('unhandledRejection', onUnhandledRejection);
