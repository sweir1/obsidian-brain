/**
 * Structured stderr logger for the MCP server's informational output.
 *
 * **Why this exists.** The server writes ~90 informational stderr lines as
 * plain text (`obsidian-brain: <message>`). Operators piping logs into log
 * aggregators (Datadog, Loki, Vector, journald with json-formatted ingest)
 * want one-JSON-object-per-line output so they can index on level, message,
 * and structured fields without regex-extracting them from prose. Gate the
 * structured mode on an env var so the default human-readable format is
 * preserved (no breaking change for users tailing the file by eye).
 *
 * **Why async writes (process.stderr.write).** Informational logs from
 * indexer / watcher / embedder paths fire well after preflight returns and
 * well before any crash. The race that v1.7.7 documents (async stderr buffer
 * vs process.exit) only matters for the crash-path sites in
 * `src/preflight.ts`, `src/global-handlers.ts`, and the writeSync fallback
 * in `src/server.ts:287`. Those sites stay on `fs.writeSync(2, …)` — this
 * module is explicitly NOT for them.
 *
 * **Why read env on every call.** Tests need to override
 * `OBSIDIAN_BRAIN_LOG_FORMAT` between describe blocks. Reading the env on
 * each invocation costs a single object-property lookup (env var access is
 * O(1) in Node) — well below the cost of the JSON.stringify or the
 * stderr.write itself. Production deployments set the var once at process
 * start, so the read is effectively constant for them too.
 *
 * **Output formats:**
 *   - Default (env unset / empty): `obsidian-brain: <message>\n` —
 *     preserves the existing user-visible format.
 *   - `OBSIDIAN_BRAIN_LOG_FORMAT=ndjson`: one JSON object per line, with
 *     keys `ts` (ISO-8601 UTC timestamp), `level` (info|warn|error),
 *     `msg` (the message string), plus any structured fields merged in.
 *     `JSON.stringify` handles control-character escaping per the JSON
 *     spec, so newlines / tabs / quotes in messages produce valid JSON.
 */

export type LogLevel = 'info' | 'warn' | 'error';

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function isNdjsonMode(): boolean {
  return process.env.OBSIDIAN_BRAIN_LOG_FORMAT === 'ndjson';
}

function emit(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
  if (isNdjsonMode()) {
    // Build the envelope first so any caller-supplied `ts` / `level` / `msg`
    // keys in `fields` cannot shadow ours — order of property iteration on
    // a plain object literal preserves declaration order, so ts/level/msg
    // always come first; if `fields` redefines them we deliberately let
    // the caller's value win (matches the "merge in alongside" requirement)
    // EXCEPT we want our canonical envelope to be authoritative — so
    // construct in caller-fields-first order, then overwrite with ours.
    const obj: Record<string, unknown> = { ...(fields ?? {}) };
    obj.ts = new Date().toISOString();
    obj.level = level;
    obj.msg = message;
    process.stderr.write(JSON.stringify(obj) + '\n');
    return;
  }
  // Plain-text fallback — fields are intentionally dropped; the historical
  // human-readable format encoded structured data into the message string,
  // and we don't want to start appending `{count: 42}` to messages users
  // are already accustomed to scanning.
  process.stderr.write(`obsidian-brain: ${message}\n`);
}

export const logger: Logger = {
  info(message, fields) {
    emit('info', message, fields);
  },
  warn(message, fields) {
    emit('warn', message, fields);
  },
  error(message, fields) {
    emit('error', message, fields);
  },
};
