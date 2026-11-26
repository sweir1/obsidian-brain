import type { Command } from 'commander';
import { createContext, type ServerContext } from '../context.js';
import { UserError, formatUserError } from '../errors.js';
import {
  computeVaultHealth,
  HEALTH_CHECKS,
  DEFAULT_FINDINGS_LIMIT,
  DEFAULT_MIN_BODY_CHARS,
  type HealthCheck,
  type VaultHealthOptions,
} from '../tools/vault-health.js';
import { printJson } from './models/output.js';

/**
 * `obsidian-brain health` — the CLI face of the `vault_health` MCP tool.
 * Both call `computeVaultHealth()`, so the JSON on stdout is exactly the
 * tool's `data` payload (minus the MCP-only `next_actions` envelope).
 *
 * Exit codes (stable — scripts and git hooks branch on them):
 *   0  no error-severity findings (warn / info findings may still exist)
 *   1  at least one error-severity finding
 *   2  bad arguments or configuration (unknown check, bad number, no VAULT_PATH)
 *   3  unexpected internal error (SQL failure, unreadable vault, ...) — kept
 *      distinct from 1 so a crash is never mistaken for "findings found"
 *
 * Uses `process.exitCode` rather than `process.exit()` so a large report
 * piped to another process is fully flushed before Node exits.
 */

export const EXIT_OK = 0;
export const EXIT_FINDINGS = 1;
export const EXIT_USAGE = 2;
export const EXIT_INTERNAL = 3;

interface RawHealthOpts {
  checks?: string;
  scope?: string;
  limit?: string;
  minBodyChars?: string;
}

class UsageError extends Error {}

function parseChecks(raw: string): HealthCheck[] {
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (parts.length === 0) {
    throw new UsageError(`--checks needs at least one check. Valid: ${HEALTH_CHECKS.join(', ')}.`);
  }
  const unknown = parts.filter((p) => !(HEALTH_CHECKS as readonly string[]).includes(p));
  if (unknown.length > 0) {
    throw new UsageError(
      `unknown check${unknown.length === 1 ? '' : 's'} for --checks: ${unknown.join(', ')}. Valid: ${HEALTH_CHECKS.join(', ')}.`,
    );
  }
  return parts as HealthCheck[];
}

function parseInteger(raw: string, flag: string, min: number): number {
  const n = Number(raw);
  if (!/^\s*\d+\s*$/.test(raw) || !Number.isSafeInteger(n) || n < min) {
    throw new UsageError(`${flag} must be an integer ≥ ${min} (got '${raw}').`);
  }
  return n;
}

/** Validate raw Commander strings into `computeVaultHealth` options. Throws UsageError. */
export function parseHealthOptions(raw: RawHealthOpts): VaultHealthOptions {
  const opts: VaultHealthOptions = {};
  if (raw.checks !== undefined) opts.checks = parseChecks(raw.checks);
  if (raw.scope !== undefined) opts.scope = raw.scope;
  if (raw.limit !== undefined) opts.limit = parseInteger(raw.limit, '--limit', 1);
  if (raw.minBodyChars !== undefined) {
    opts.minBodyChars = parseInteger(raw.minBodyChars, '--min-body-chars', 0);
  }
  return opts;
}

/** Same shape the top-level CLI handler prints for non-UserError failures. */
function reportInternalError(err: unknown): number {
  process.stderr.write(
    `CLI error: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  return EXIT_INTERNAL;
}

/**
 * Run the command and return the exit code. Never calls `process.exit` and
 * never throws: every failure maps onto one of the documented exit codes.
 * `makeContext` is injectable for tests; production uses `createContext`.
 */
export async function runHealthCommand(
  raw: RawHealthOpts,
  makeContext: () => Promise<Pick<ServerContext, 'db' | 'config'>> = createContext,
): Promise<number> {
  let opts: VaultHealthOptions;
  try {
    opts = parseHealthOptions(raw);
  } catch (err) {
    process.stderr.write(`obsidian-brain: ${(err as Error).message}\n`);
    return EXIT_USAGE;
  }

  let ctx: Pick<ServerContext, 'db' | 'config'>;
  try {
    ctx = await makeContext();
  } catch (err) {
    // Missing VAULT_PATH and friends: a configuration problem, not a
    // finding — keep it out of exit code 1 so scripts can tell them apart.
    if (err instanceof UserError) {
      process.stderr.write(formatUserError(err));
      return EXIT_USAGE;
    }
    return reportInternalError(err);
  }

  try {
    const report = await computeVaultHealth(ctx.db, ctx.config.vaultPath, opts);
    const indexed = (
      ctx.db
        .prepare("SELECT COUNT(*) AS n FROM nodes WHERE COALESCE(json_extract(frontmatter, '$._stub'), 0) != 1")
        .get() as { n: number }
    ).n;
    if (indexed === 0) {
      process.stderr.write(
        "obsidian-brain: the index is empty — run 'obsidian-brain index' first, otherwise every note is reported as not_indexed.\n",
      );
    }
    printJson(report);
    return report.bySeverity.error > 0 ? EXIT_FINDINGS : EXIT_OK;
  } catch (err) {
    return reportInternalError(err);
  } finally {
    ctx.db.close();
  }
}

export function registerHealthCommand(program: Command): void {
  program
    .command('health')
    .description(
      'Lint the vault from the index: broken links, broken heading/block anchors, orphans, missing frontmatter, near-empty notes, duplicate names, index drift. Prints JSON; exit 1 if any error-severity finding, 2 on bad arguments.',
    )
    .option('-c, --checks <list>', `Comma-separated checks to run (default: all). Valid: ${HEALTH_CHECKS.join(', ')}`)
    .option('-s, --scope <folder>', 'Only report notes under this vault-relative folder')
    .option('-l, --limit <n>', `Max findings listed per check; counts stay complete (default: ${DEFAULT_FINDINGS_LIMIT})`)
    .option(
      '--min-body-chars <n>',
      `empty_notes threshold: body shorter than this is reported (default: ${DEFAULT_MIN_BODY_CHARS})`,
    )
    .action(async (raw: RawHealthOpts) => {
      process.exitCode = await runHealthCommand(raw);
    });
}
