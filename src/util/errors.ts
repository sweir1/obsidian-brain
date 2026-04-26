// Extract a human-readable message from an unknown thrown value.
//
// Replaces the recurring inline pattern
//   `err instanceof Error ? err.message : String(err)`
// that appeared on every catch-site in the codebase. Centralising means:
//   1. One rationale comment covers every use-site (see v8-ignore below).
//   2. A future bug in the formatter fix lands in one place, not ten.
//
// The `else` branch is coverage-excluded because every caller in this
// codebase catches from either:
//   - `fs.readFile` / other Node APIs (throw NodeError, an Error subclass)
//   - locally-thrown `new Error(...)` (via need(), applyEdit, etc.)
//   - `JSON.parse` (throws SyntaxError, an Error subclass)
//   - MCP tool handlers (always throw Error-derived)
//
// V8 cannot statically prove the else branch is unreachable, but the cost
// of writing a test that throws a bare string or number just to hit
// `String(err)` is coverage theatre — the assertion would pass on broken
// formatting exactly as it passes today. Ignoring the branch keeps the
// gate honest.
import { debugLog } from './debug-log.js';

debugLog('module-load: src/util/errors.ts');

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  /* v8 ignore next -- defensive: no call site throws non-Error values */
  return String(err);
}
