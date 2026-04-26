/**
 * Native-module ABI-mismatch auto-heal.
 *
 * Extracted from src/context.ts so `src/preflight.ts` can call it BEFORE any
 * other module (including context.ts itself) has loaded. Two failure paths
 * we cover today:
 *
 *   1. better-sqlite3 (`NODE_MODULE_VERSION` mismatch from a stale npx cache
 *      after a Node version change). Heal: spawn `npm rebuild better-sqlite3`
 *      detached + tell the user to restart their MCP client.
 *   2. sqlite-vec (`ERR_DLOPEN_FAILED` because the platform-specific
 *      optional-dep package is missing or wrong-arch). Heal: spawn
 *      `npm install sqlite-vec-${platform}-${arch}` detached + same restart.
 *
 * Both paths share the same outer envelope: per-(module, ABI) marker file
 * in `~/.cache/obsidian-brain/` to prevent infinite retry, detached + unref
 * so the user's MCP client can exit cleanly while the rebuild continues,
 * and an identical user-facing message format so docs / troubleshooting
 * can describe one flow.
 *
 * Every public function in here ALWAYS THROWS — the only successful return
 * is "the native module loaded fine, no heal needed", which is the absence
 * of any call into here.
 */
import { existsSync, mkdirSync, openSync, unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { errorMessage } from './util/errors.js';

export type NativeModule = 'better-sqlite3' | 'sqlite-vec';

/**
 * Heuristics that identify an ABI / dlopen failure across the two native
 * modules we depend on. Top-precedence patterns first.
 *
 * `NODE_MODULE_VERSION` — better-sqlite3 family, the canonical signal that
 *   the binary was compiled for a different Node major.
 * `ERR_DLOPEN_FAILED` — Node's own error code for failed native loads,
 *   used when the binary is missing, wrong-arch, or corrupt.
 *
 * The second-tier patterns catch failure modes that can fall outside the
 * canonical errors — newer better-sqlite3 versions occasionally word the
 * mismatch differently; sqlite-vec's optional-dep miss can show up as
 * "Cannot find module" before getting to dlopen.
 */
const ABI_FAILURE_RE =
  /NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|was compiled against a different Node\.js version|dlopen.*Symbol not found|dlopen.*image not found|incompatible architecture|Cannot find module 'sqlite-vec/i;

export function isLikelyAbiFailure(msg: string): boolean {
  return ABI_FAILURE_RE.test(msg);
}

/**
 * Top-level entry. Always throws — caller should let the throw propagate
 * (or convert it to a stderr write + process.exit). On the happy path of
 * "auto-heal could be triggered", the throw carries a user-actionable
 * message saying "rebuild started, restart your MCP client in ~1 minute".
 * On any unexpected internal error, throws the plain remediation message
 * instead — the user always gets something actionable.
 */
export function tryAutoHealAbiMismatch(underlyingErr: string, module: NativeModule): never {
  try {
    doAutoHeal(underlyingErr, module);
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('obsidian-brain: Node ABI mismatch')) {
      throw err; // our constructed message — propagate as-is
    }
    // Anything else: log for debugging and fall back to plain message.
    process.stderr.write(
      `obsidian-brain: auto-heal encountered an unexpected error (falling back to manual remediation): ${errorMessage(err)}\n`,
    );
    throw new Error(
      buildAbiMismatchMessage(underlyingErr, module, { autoHeal: false, logPath: null }),
    );
  }
  // Unreachable: doAutoHeal always throws.
  throw new Error(
    buildAbiMismatchMessage(underlyingErr, module, { autoHeal: false, logPath: null }),
  );
}

function doAutoHeal(underlyingErr: string, module: NativeModule): never {
  const runtimeAbi = process.versions.modules;

  if (process.platform === 'win32') {
    throw new Error(
      buildAbiMismatchMessage(underlyingErr, module, { autoHeal: false, logPath: null }),
    );
  }

  // Resolve the project root that anchors the failed module's install.
  // `require.resolve` only inspects paths, not binary contents, so it works
  // even when the module's .node file is broken.
  const require_ = createRequire(import.meta.url);
  let projectRoot: string | null = null;
  let staleBinary: string | null = null;
  try {
    if (module === 'better-sqlite3') {
      const pkgJsonPath = require_.resolve('better-sqlite3/package.json');
      const pkgRoot = dirname(pkgJsonPath); // .../node_modules/better-sqlite3
      // `npm rebuild <pkg>` anchors on the PROJECT ROOT — three dirnames up.
      projectRoot = dirname(dirname(dirname(pkgJsonPath)));
      staleBinary = join(pkgRoot, 'build', 'Release', 'better_sqlite3.node');
    } else {
      // sqlite-vec — anchor via its package.json the same way.
      const pkgJsonPath = require_.resolve('sqlite-vec/package.json');
      projectRoot = dirname(dirname(dirname(pkgJsonPath)));
      // sqlite-vec's binary lives in the per-platform optional dep (e.g.
      // sqlite-vec-darwin-arm64), not in sqlite-vec/build itself. Skipping
      // the up-front delete for sqlite-vec — `npm install` will overwrite.
    }
  } catch {
    throw new Error(
      buildAbiMismatchMessage(underlyingErr, module, { autoHeal: false, logPath: null }),
    );
  }

  // Per-(module, ABI/arch) marker so a broken toolchain doesn't trap us in
  // an infinite heal loop. better-sqlite3 keys by ABI; sqlite-vec keys by
  // platform-arch (its optional deps are platform-specific, not ABI-specific).
  const cacheDir = join(homedir(), '.cache', 'obsidian-brain');
  const markerKey =
    module === 'better-sqlite3'
      ? `abi-heal-attempted-better-sqlite3-${runtimeAbi}`
      : `abi-heal-attempted-sqlite-vec-${process.platform}-${process.arch}`;
  const markerPath = join(cacheDir, markerKey);
  try {
    mkdirSync(cacheDir, { recursive: true });
  } catch {
    /* best-effort */
  }

  if (existsSync(markerPath)) {
    throw new Error(
      `obsidian-brain: Node ABI mismatch — auto-heal already attempted for ` +
        `${module} (NODE_MODULE_VERSION=${runtimeAbi}, Node ${process.version}) ` +
        `but the module is still incompatible. The rebuild itself likely failed ` +
        `(often a missing C++ toolchain).\n` +
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

  // Belt-and-braces: nuke the stale binary before rebuild. better-sqlite3's
  // prebuild-install will overwrite build/Release/*.node when it unpacks
  // the correct-ABI tarball, but deleting up-front guarantees a clean slate.
  if (staleBinary) {
    try {
      if (existsSync(staleBinary)) unlinkSync(staleBinary);
    } catch {
      /* best-effort */
    }
  }

  // Write marker BEFORE spawn so a concurrent restart during the ~60s
  // rebuild window sees "already attempted" and skips.
  try {
    writeFileSync(markerPath, runtimeAbi);
  } catch {
    /* best-effort */
  }

  const logPath = join(tmpdir(), `obsidian-brain-${module}-rebuild-${Date.now()}-${process.pid}.log`);
  let logFd: number | null = null;
  try {
    logFd = openSync(logPath, 'w');
  } catch {
    /* falling back to ignore */
  }

  // Choose the right command for the failing module.
  const [cmd, args] =
    module === 'better-sqlite3'
      ? ['npm', ['rebuild', 'better-sqlite3']]
      : ['npm', ['install', '--no-save', `sqlite-vec-${process.platform}-${process.arch}`]];

  try {
    const child = spawn(cmd, args, {
      cwd: projectRoot,
      detached: true,
      stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
    });
    child.unref();
    throw new Error(
      buildAbiMismatchMessage(underlyingErr, module, {
        autoHeal: true,
        logPath,
        rebuildPid: child.pid,
      }),
    );
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('obsidian-brain: Node ABI mismatch')) {
      throw err; // our own constructed message
    }
    // spawn failure (e.g. npm not on PATH) — clear the marker so a future
    // boot can retry once the underlying issue is fixed.
    try {
      unlinkSync(markerPath);
    } catch {
      /* best-effort */
    }
    throw new Error(
      buildAbiMismatchMessage(underlyingErr, module, { autoHeal: false, logPath: null }),
    );
  }
}

function buildAbiMismatchMessage(
  underlyingErr: string,
  module: NativeModule,
  opts: { autoHeal: boolean; logPath: string | null; rebuildPid?: number },
): string {
  const header =
    `obsidian-brain: Node ABI mismatch — the native module \`${module}\` was compiled ` +
    `for a different Node major version than this runtime ` +
    `(NODE_MODULE_VERSION=${process.versions.modules}, Node ${process.version}).`;
  const cause = `Most likely cause: a cached npx install from a previous Node version.`;

  if (opts.autoHeal) {
    const verb = module === 'better-sqlite3' ? 'rebuild' : 'install';
    return (
      `${header}\n\n${cause}\n\n` +
      `Auto-heal: a background ${verb} of ${module} was started` +
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
