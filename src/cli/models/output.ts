/**
 * TTY-aware output helpers for `obsidian-brain models` subcommands.
 */

/**
 * Print `obj` as structured JSON to stdout (always). When stdout is a TTY
 * also pretty-print a human-readable summary to stderr so piping still gets
 * clean JSON while interactive users get readable output.
 */
export function printJson(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}
