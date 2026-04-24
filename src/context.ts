import { existsSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { openDb, ensureVecTables, type DatabaseHandle } from './store/db.js';
import type { Embedder } from './embeddings/types.js';
import { createEmbedder } from './embeddings/factory.js';
import { Search } from './search/unified.js';
import { VaultWriter } from './vault/writer.js';
import { IndexPipeline } from './pipeline/indexer.js';
import { bootstrap, type BootstrapResult } from './pipeline/bootstrap.js';
import { ObsidianClient } from './obsidian/client.js';
import { resolveConfig, type Config } from './config.js';
import { errorMessage } from './util/errors.js';

/**
 * Shared runtime state that every tool handler needs. Constructed once at
 * server startup and captured by each tool's registration closure.
 *
 * `embedder` is instantiated but NOT initialized — call `ensureEmbedderReady`
 * before touching semantic search. First call downloads the default
 * embedding model (~34MB for the v1.5.2 default bge-small-en-v1.5), so
 * we defer it until actually needed.
 *
 * `getBootstrap` returns the result of the last startup compatibility check
 * (model/schema change detection). `null` until `ensureEmbedderReady` has
 * run at least once — the check can't happen until the embedder knows its
 * dimensions.
 */
export interface ServerContext {
  db: DatabaseHandle;
  embedder: Embedder;
  search: Search;
  writer: VaultWriter;
  pipeline: IndexPipeline;
  config: Config;
  obsidian: ObsidianClient;
  ensureEmbedderReady: () => Promise<void>;
  getBootstrap: () => BootstrapResult | null;
  embedderReady: () => boolean;
  initError: unknown | undefined;
  /**
   * Tracks the tail of the fire-and-forget reindex chain from write tools.
   * In production nothing awaits this — the writes return immediately and
   * the reindex drains in the background. In tests, afterEach awaits
   * `ctx.pendingReindex` before tearing down the temp vault / closing the
   * DB so the trailing reindex doesn't ENOENT against a deleted directory.
   * Always a resolved promise when no work is queued.
   */
  pendingReindex: Promise<void>;
  /**
   * Internal hook — write tools call this to chain their fire-and-forget
   * reindex onto the tail of `pendingReindex`. Not part of the user API.
   */
  enqueueBackgroundReindex: (work: () => Promise<void>) => void;
  /**
   * True while a background reindex is actively running (e.g. triggered by a
   * PREFIX_STRATEGY_VERSION bump or embedder change). Distinct from the
   * embedder-not-yet-ready state — allows search to surface a more accurate
   * "re-embedding in progress" message instead of the "still downloading"
   * first-run message.
   */
  reindexInProgress: boolean;
}

export async function createContext(): Promise<ServerContext> {
  const config = resolveConfig({});
  mkdirSync(config.dataDir, { recursive: true });
  let db: DatabaseHandle;
  try {
    db = openDb(config.dbPath);
  } catch (err: unknown) {
    const msg = errorMessage(err);
    if (/NODE_MODULE_VERSION|ERR_DLOPEN_FAILED/.test(msg)) {
      tryAutoHealAbiMismatch(msg); // throws with either a heal-started or heal-failed message
    }
    throw err;
  }
  const embedder = createEmbedder();
  const search = new Search(db, embedder);
  const writer = new VaultWriter(config.vaultPath, db);
  const pipeline = new IndexPipeline(db, embedder);
  const obsidian = new ObsidianClient(config.vaultPath);

  let bootstrapResult: BootstrapResult | null = null;
  let embedderInitialized = false;

  // Cache the init promise so concurrent callers (e.g. a tool call racing the
  // background startup catchup) share one model load instead of initialising
  // the embedder twice.
  let initPromise: Promise<void> | null = null;
  const ensureEmbedderReady = (): Promise<void> => {
    if (!initPromise) {
      initPromise = (async () => {
        await embedder.init();
        // Before anything writes to nodes_vec/chunks_vec, reconcile the
        // stored embedder identity against the live one and (potentially)
        // queue a reindex.
        bootstrapResult = bootstrap(db, embedder);
        ensureVecTables(db, embedder.dimensions());
        embedderInitialized = true;
      })();
    }
    return initPromise;
  };

  const ctx: ServerContext = {
    db,
    embedder,
    search,
    writer,
    pipeline,
    config,
    obsidian,
    ensureEmbedderReady,
    getBootstrap: () => bootstrapResult,
    embedderReady: () => embedderInitialized,
    initError: undefined,
    pendingReindex: Promise.resolve(),
    reindexInProgress: false,
    enqueueBackgroundReindex(work) {
      // Chain onto the current tail — .finally() runs the work whether
      // the prior chain resolved or rejected, so a failed reindex never
      // blocks subsequent ones. We wrap with try/finally to track
      // reindexInProgress so search can surface accurate status messages.
      ctx.pendingReindex = ctx.pendingReindex.finally(async () => {
        try {
          ctx.reindexInProgress = true;
          await work();
        } catch (err) {
          process.stderr.write(
            `obsidian-brain: background reindex failed: ${String(err)}\n`,
          );
        } finally {
          ctx.reindexInProgress = false;
        }
      });
    },
  };
  return ctx;
}

/**
 * v1.6.11 auto-heal: when a native module (typically better-sqlite3) fails
 * to load because its compiled ABI doesn't match the current Node, spawn a
 * detached `npm rebuild better-sqlite3` in the background and tell the
 * user to restart. The rebuild outlives this process thanks to
 * `detached: true` + `.unref()`; by the time the user restarts their MCP
 * client (~10-60s), the rebuild is usually complete and next startup
 * succeeds cleanly.
 *
 * A per-ABI marker file prevents infinite-rebuild loops if the rebuild
 * itself keeps failing (e.g. missing C++ toolchain) — the first attempt
 * is logged to /tmp, the second attempt for the same ABI falls through
 * to a plain remediation message pointing at the log.
 *
 * Skipped on Windows for v1.6.11: detached subprocess semantics differ
 * (windowsHide / process-group handling) and concurrent-restart lockfile
 * races haven't been validated there. Windows users get the original
 * v1.6.10 remediation message.
 *
 * This function always throws. The OUTER try/catch is a hard guarantee —
 * if ANY step inside doAutoHeal fails unexpectedly (path-resolution,
 * filesystem, spawn, anything), we degrade to the plain remediation
 * message instead of crashing with an unrelated stack trace. The user
 * always gets something actionable; auto-heal is purely best-effort.
 */
function tryAutoHealAbiMismatch(underlyingErr: string): never {
  try {
    doAutoHeal(underlyingErr);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('obsidian-brain: Node ABI mismatch')) {
      throw err; // our constructed message — propagate as-is
    }
    // Anything else: log for debugging and fall back to plain message.
    process.stderr.write(
      `obsidian-brain: auto-heal encountered an unexpected error (falling back to manual remediation): ${errorMessage(err)}\n`,
    );
    throw new Error(buildAbiMismatchMessage(underlyingErr, { autoHeal: false, logPath: null }));
  }
  // Unreachable: doAutoHeal always throws.
  throw new Error(buildAbiMismatchMessage(underlyingErr, { autoHeal: false, logPath: null }));
}

function doAutoHeal(underlyingErr: string): never {
  const runtimeAbi = process.versions.modules;
  const nodeVer = process.version;

  if (process.platform === 'win32') {
    throw new Error(buildAbiMismatchMessage(underlyingErr, { autoHeal: false, logPath: null }));
  }

  // Best-effort: locate better-sqlite3's package root AND the project root
  // anchoring its install. We can't `import` the module (that's the thing
  // that's broken); `require.resolve` works because it only inspects paths,
  // not binary contents.
  const require_ = createRequire(import.meta.url);
  let pkgRoot: string | null = null;
  let projectRoot: string | null = null;
  try {
    const pkgJsonPath = require_.resolve('better-sqlite3/package.json');
    pkgRoot = dirname(pkgJsonPath);                       // .../node_modules/better-sqlite3
    // `npm rebuild <pkg>` anchors on the PROJECT ROOT's package.json via
    // Arborist's loadActual(), which scans the whole node_modules inventory
    // (direct + transitive). So we need to go one level above node_modules
    // itself: three dirnames from better-sqlite3/package.json.
    projectRoot = dirname(dirname(dirname(pkgJsonPath))); // project root
  } catch {
    throw new Error(buildAbiMismatchMessage(underlyingErr, { autoHeal: false, logPath: null }));
  }

  // Marker file per ABI so a broken toolchain doesn't trap us in an
  // infinite heal loop. Users changing Node versions get one attempt per
  // ABI, which is the desired behavior.
  const cacheDir = join(homedir(), '.cache', 'obsidian-brain');
  const markerPath = join(cacheDir, `abi-heal-attempted-${runtimeAbi}`);
  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch {
    /* best-effort */
  }

  if (existsSync(markerPath)) {
    // Already tried once for this ABI and still failing — don't loop.
    throw new Error(
      `obsidian-brain: Node ABI mismatch — auto-heal already attempted for ` +
        `NODE_MODULE_VERSION=${runtimeAbi} (Node ${nodeVer}) but the module is ` +
        `still incompatible. The rebuild itself likely failed (often a missing ` +
        `C++ toolchain).\n` +
        `\n` +
        `Manual fix:\n` +
        `  rm -rf ~/.npm/_npx\n` +
        `\n` +
        `If that also fails, install a C++ toolchain and retry:\n` +
        `  macOS: xcode-select --install\n` +
        `  Debian/Ubuntu: sudo apt install build-essential python3\n` +
        `  Fedora/RHEL: sudo dnf install gcc-c++ make python3\n` +
        `\n` +
        `Clear the retry marker to try auto-heal again after fixing the\n` +
        `underlying issue: rm ${markerPath}\n` +
        `\n` +
        `See https://sweir1.github.io/obsidian-brain/troubleshooting/#err_dlopen_failed-node_module_version-mismatch\n` +
        `\n` +
        `Underlying error: ${underlyingErr}`,
    );
  }

  // Belt-and-braces: nuke the stale binary before rebuild. prebuild-install
  // (better-sqlite3's install mechanism) will overwrite build/Release/*.node
  // when it unpacks the correct-ABI tarball anyway, but deleting up-front
  // guarantees a clean slate even if prebuild-install's logic ever changes
  // or its own tarball cache has corrupted bits.
  const staleBinary = join(pkgRoot, 'build', 'Release', 'better_sqlite3.node');
  try {
    if (existsSync(staleBinary)) unlinkSync(staleBinary);
  } catch {
    /* best-effort */
  }

  // Write marker BEFORE spawn so a concurrent restart during the ~60s
  // rebuild window sees "already attempted" and skips (avoids two npm
  // rebuilds racing on the same node_modules).
  try {
    writeFileSync(markerPath, runtimeAbi);
  } catch {
    /* best-effort — if we can't write the marker, heal still runs but
       may retry on next boot; better than not trying */
  }

  const logPath = join(tmpdir(), `obsidian-brain-rebuild-${Date.now()}-${process.pid}.log`);
  let logFd: number | null = null;
  try {
    logFd = openSync(logPath, 'w');
  } catch {
    /* falling back to ignore */
  }

  try {
    // Note: --update-binary is NOT passed. It's a node-pre-gyp flag;
    // better-sqlite3 uses prebuild-install and would not understand it.
    // Plain `npm rebuild better-sqlite3` re-runs the install script which
    // unpacks a correct-ABI prebuilt (or compiles from source as fallback).
    const child = spawn('npm', ['rebuild', 'better-sqlite3'], {
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
    });
    child.unref();
    throw new Error(
      buildAbiMismatchMessage(underlyingErr, {
        autoHeal: true,
        logPath,
        rebuildPid: child.pid,
      }),
    );
  } catch (err) {
    // If spawn itself failed (e.g. npm not on PATH), tell the user to fix
    // manually. Don't leave the marker behind in that case — spawn failure
    // is not an attempt at healing, so clear so a future boot can retry.
    if (err instanceof Error && err.message.startsWith('obsidian-brain: Node ABI mismatch')) {
      throw err; // our own constructed message, re-throw
    }
    // Best-effort marker cleanup.
    try {
      unlinkSync(markerPath);
    } catch {
      /* best-effort */
    }
    throw new Error(buildAbiMismatchMessage(underlyingErr, { autoHeal: false, logPath: null }));
  }
}

function buildAbiMismatchMessage(
  underlyingErr: string,
  opts: { autoHeal: boolean; logPath: string | null; rebuildPid?: number },
): string {
  const header =
    `obsidian-brain: Node ABI mismatch — a native module was compiled for a ` +
    `different Node major version than this runtime ` +
    `(NODE_MODULE_VERSION=${process.versions.modules}, Node ${process.version}).`;
  const cause = `Most likely cause: a cached npx install from a previous Node version.`;

  if (opts.autoHeal) {
    return (
      `${header}\n\n${cause}\n\n` +
      `Auto-heal: a background rebuild of better-sqlite3 was started` +
      (opts.rebuildPid ? ` (PID ${opts.rebuildPid})` : '') +
      `. It takes roughly 10-60 seconds depending on your network and\n` +
      `whether a prebuilt binary is available for your platform.\n` +
      `\n` +
      `Please restart your MCP client (quit and reopen Claude Desktop, Jan,\n` +
      `Cursor, etc.) in about 1 minute. The server should then start cleanly.\n` +
      `\n` +
      (opts.logPath ? `Rebuild log: ${opts.logPath}\n\n` : '') +
      `If the error persists after restart:\n` +
      `  rm -rf ~/.npm/_npx\n` +
      `\n` +
      `See https://sweir1.github.io/obsidian-brain/troubleshooting/#err_dlopen_failed-node_module_version-mismatch\n` +
      `\n` +
      `Underlying error: ${underlyingErr}`
    );
  }

  return (
    `${header}\n\n${cause}\n\n` +
    `Fix: rm -rf ~/.npm/_npx   (then restart your MCP client)\n` +
    `\n` +
    `See https://sweir1.github.io/obsidian-brain/troubleshooting/#err_dlopen_failed-node_module_version-mismatch\n` +
    `\n` +
    `Underlying error: ${underlyingErr}`
  );
}
