/**
 * Native-module preflight — MUST be the first import in src/cli/index.ts.
 *
 * Why this exists:
 *
 *   The crash mode this fixes is the silent ABI failure where Claude
 *   Desktop's MCP transport spawns the npx-cached obsidian-brain after a
 *   Node version change, the cached `better-sqlite3.node` (or
 *   `sqlite-vec`'s platform-specific `.dylib`) is incompatible with the
 *   current Node, and the process dies with no error in the log.
 *
 *   Two failure modes stack:
 *
 *   1. **Top-level `import` of native modules fails.** ES `import`
 *      statements in `src/store/db.ts:1-2` are evaluated as part of the
 *      module graph BEFORE any user code (including the CLI's outer
 *      try/catch) runs. A throw at that layer can't be caught by anything
 *      downstream — the process dies with Node's default uncaughtException
 *      handler, which prints to fd 2 but races with `process.exit(1)`.
 *
 *   2. **`process.stderr.write()` is async on pipes.** The catch handlers
 *      in startServer / cli/index.ts use `process.stderr.write(msg)`, which
 *      enqueues bytes into Node's internal stream buffer. `process.exit(1)`
 *      doesn't wait for that buffer to flush — bytes can sit there until
 *      the process is already gone, and Claude Desktop sees EOF on stderr
 *      without ever reading the error.
 *
 * What this module does:
 *
 *   - Uses `createRequire(import.meta.url)` to load each native module
 *     synchronously inside try/catch. Static `import` can't go inside
 *     try/catch (syntax error); `createRequire` gives us CJS-style
 *     `require()` that we CAN wrap. Once preflight succeeds, downstream
 *     ESM `import` statements in db.ts hit Node's module cache and skip
 *     the load — no second chance to fail.
 *
 *   - On failure: writes the error to a known crash-log file via
 *     synchronous `writeFileSync`, AND writes a banner to fd 2 via
 *     synchronous `fs.writeSync(2, …)`. Both syscalls block until the
 *     OS accepts the bytes — `process.exit(1)` after that is safe.
 *
 *   - Dispatches to `tryAutoHealAbiMismatch` for ABI/dlopen failures so
 *     the user gets a background rebuild kicked off + a clear "restart
 *     your MCP client in ~1 minute" message.
 *
 *   - Adds ~10 ms to cold start. Negligible vs. the embedder load.
 */
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// **FIRST EXECUTABLE STATEMENT.** Capture OBSIDIAN_BRAIN_DEBUG before any
// other top-level work runs. If anything else in this module throws at
// load time (extremely rare — only stdlib imports above), at least
// debug-mode is already known and the synchronous trace function below
// is armed. Subsequent debug calls anywhere in startup use this captured
// value, which means the env var is read EXACTLY ONCE at the absolute
// earliest moment our JS code runs.
const _DEBUG = process.env.OBSIDIAN_BRAIN_DEBUG === '1';
function dbg(msg: string): void {
  if (!_DEBUG) return;
  try {
    writeSync(2, `obsidian-brain debug [+${Math.round(process.uptime() * 1000)}ms]: ${msg}\n`);
  } catch { /* fd 2 closed somehow — drop silently */ }
}
dbg('preflight: module loaded (debug mode active)');

const require_ = createRequire(import.meta.url);
dbg('preflight: createRequire resolved');

const NATIVE_MODULES = ['better-sqlite3', 'sqlite-vec'] as const;
type NativeModuleName = (typeof NATIVE_MODULES)[number];

/**
 * Synchronous double-write: stderr (visible to MCP client) + crash-log
 * file (recoverable if MCP client swallows stderr). Both blocking; we want
 * the bytes on disk and in the pipe before the process exits.
 */
function recordCrash(module: NativeModuleName, err: unknown): void {
  const errStack = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
  const banner =
    `\nobsidian-brain: ✗ Native module load failed before server could start.\n` +
    `  Module:  ${module}\n` +
    `  Node:    ${process.version} (NODE_MODULE_VERSION ${process.versions.modules})\n` +
    `  Detail:  ~/.cache/obsidian-brain/last-startup-error.log\n\n`;

  // Synchronous fs.writeSync(2, …) — bypasses Node's async stderr buffering
  // so the bytes reach Claude Desktop's stderr pipe before process.exit.
  try {
    writeSync(2, banner + errStack + '\n');
  } catch {
    /* fd 2 closed somehow — fall through */
  }

  try {
    const dir = join(homedir(), '.cache', 'obsidian-brain');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'last-startup-error.log'),
      `# obsidian-brain native-module load failure\n` +
        `timestamp: ${new Date().toISOString()}\n` +
        `node:      ${process.version}\n` +
        `abi:       ${process.versions.modules}\n` +
        `platform:  ${process.platform}-${process.arch}\n` +
        `module:    ${module}\n` +
        `\n` +
        errStack +
        '\n',
    );
  } catch {
    /* best-effort */
  }
}

/**
 * Run the preflight. Loads each native module synchronously; on the first
 * failure, records the crash, attempts the auto-heal, writes the heal's
 * user-facing message, and exits.
 *
 * On success: returns. Module exports are now cached in Node's require
 * cache; subsequent ESM `import` statements in db.ts resolve from cache.
 */
function runPreflight(): void {
  // First line on every boot: print the runtime identity to fd 2 so
  // Claude Desktop's obsidian-brain log records which Node + ABI + platform
  // the server is using. Diagnosing future crashes (especially ABI
  // mismatches across Node upgrades) almost always starts with "what
  // Node was active that boot?" and this answers it without the user
  // having to run anything.
  //
  // Synchronous fs.writeSync(2, …) so the bytes always reach the pipe
  // even if the very next thing we do (native-module load) crashes the
  // process before the event loop pumps.
  //
  // **Banner content (v1.7.11):**
  //   - obsidian-brain version (read from package.json via createRequire,
  //     same import-cache approach used in src/cli/index.ts:28). Lets
  //     users / support sessions identify the exact server version
  //     without running `--version` separately.
  //   - npm package-manager version (parsed from process.env.npm_config_user_agent
  //     when set by `npm` / `npx`; "n/a" otherwise — e.g. when invoked
  //     via raw `node`). Diagnostic for the npm 11.x stdio-pipe bug —
  //     a log entry showing `npm/11.x` immediately implicates that bug
  //     class.
  //   - Node version + ABI + platform — already there, kept.
  let serverVersion = '?';
  try {
    serverVersion = (require_('../package.json') as { version: string }).version;
  } catch { /* best-effort — fall back to '?' */ }

  // npm_config_user_agent format (when run via npm/npx):
  //   "npm/11.12.1 node/v24.14.1 darwin arm64 workspaces/false"
  // Take the first token (npm/X.Y.Z); if not present, mark as 'n/a'
  // (means we were spawned via plain `node`, no npm wrapper).
  const userAgent = process.env.npm_config_user_agent ?? '';
  const npmMatch = /^npm\/(\S+)/.exec(userAgent);
  const npmVersion = npmMatch ? npmMatch[1] : 'n/a';

  try {
    writeSync(
      2,
      `obsidian-brain: starting (v${serverVersion}, ` +
        `Node ${process.version}, ` +
        `NODE_MODULE_VERSION ${process.versions.modules}, ` +
        `npm ${npmVersion}, ` +
        `platform ${process.platform}-${process.arch}, ` +
        `debug=${_DEBUG ? 'on' : 'off'})\n`,
    );
  } catch {
    /* fd 2 closed somehow — fall through */
  }

  // Note: `dbg` is captured at module-top-level above this function (so
  // it's armed even if module-init code throws). Reusing here.
  dbg('preflight: starting native-module checks');

  for (const mod of NATIVE_MODULES) {
    dbg(`preflight: loading ${mod}`);
    try {
      require_(mod);
      dbg(`preflight: ${mod} loaded successfully`);
    } catch (err) {
      recordCrash(mod, err);

      // Best-effort: dispatch to auto-heal. We require it lazily AFTER the
      // crash record so a broken auto-heal module doesn't suppress the
      // real diagnostic.
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const autoHeal = require_('./auto-heal.js') as typeof import('./auto-heal.js');
        if (autoHeal.isLikelyAbiFailure(String(err))) {
          // tryAutoHealAbiMismatch ALWAYS throws — it constructs either a
          // "rebuild started, restart your client" message or a "manual
          // remediation needed" fallback. We catch it here and write the
          // message synchronously to fd 2.
          try {
            autoHeal.tryAutoHealAbiMismatch(String(err), mod);
          } catch (healMsg) {
            try {
              writeSync(2, '\n' + String(healMsg instanceof Error ? healMsg.message : healMsg) + '\n');
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* auto-heal itself is broken — the recordCrash above is enough */
      }

      process.exit(1);
    }
  }
}

runPreflight();
