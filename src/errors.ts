/**
 * Friendly-error sentinel for CLI UX.
 *
 * `UserError` marks errors that are caused by user configuration / input
 * problems (missing env var, malformed flag value, etc.). The CLI catch
 * handler at the bottom of `src/cli/index.ts` checks `instanceof UserError`
 * and prints `obsidian-brain: <message>` without a stack trace, instead of
 * the noisy "CLI error: Error: …" + full stack the default path produces.
 *
 * Internal / programmer errors (anything NOT a UserError) keep printing
 * the full stack so bugs remain debuggable.
 *
 * Optional `hint` is an additional one-line tip appended to the message —
 * useful for "did you mean X?" or "see `--help` for valid values".
 */
export class UserError extends Error {
  readonly hint?: string;

  constructor(message: string, options?: { hint?: string }) {
    super(message);
    this.name = 'UserError';
    this.hint = options?.hint;
    // Preserve the prototype chain for `instanceof` across module boundaries.
    Object.setPrototypeOf(this, UserError.prototype);
  }
}

/**
 * Format a UserError for stderr output. Used by the CLI catch handler so
 * the exact wording stays consistent across entry-points (the bin shim,
 * `npm run cli`, direct `tsx src/cli/index.ts`).
 */
export function formatUserError(err: UserError): string {
  const lines = [`obsidian-brain: ${err.message}`];
  if (err.hint) lines.push(`  ↳ ${err.hint}`);
  return lines.join('\n') + '\n';
}
