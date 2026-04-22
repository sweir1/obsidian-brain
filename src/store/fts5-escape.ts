/**
 * Escape a user query for safe use in FTS5 MATCH clauses.
 *
 * FTS5 treats these characters as operators/qualifiers: - + * " ( ) : / ^ $
 * A query like "verify-hyphen-2026" becomes parsed as `verify NOT hyphen:2026`
 * and throws `no such column: hyphen`.
 *
 * Strategy: if the query contains only word characters, spaces, and asterisks
 * (safe for FTS5 bareword parsing + prefix matching), pass it through unchanged
 * so FTS5 power syntax (AND, OR, NEAR, prefix *) continues to work for users
 * who know it. Otherwise, phrase-quote the whole thing (FTS5 treats the
 * content inside "..." as a single phrase and never parses operators from it).
 * Internal double quotes are escaped by doubling them, per FTS5 grammar.
 *
 * Per sqlite.org/fts5.html §3, double-quote phrase-matching is the canonical
 * fix for ambiguous user input.
 */
export function escapeFts5Query(query: string): string {
  if (query === '' || /^[\w\s*]+$/.test(query)) return query;
  return `"${query.replace(/"/g, '""')}"`;
}
