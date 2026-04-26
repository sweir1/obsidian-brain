import type { DatabaseHandle } from '../../store/db.js';

export function repairMissingEmbeddings(db: DatabaseHandle): { unexpectedMissing: number; noContentTotal: number } {
  // F6 v1.7.3 — Self-heal becomes a *true* diagnostic, not a retry-loop.
  //
  // Two changes vs v1.7.2:
  // 1. Check `chunks_vec` membership, not just `chunks` — notes whose
  //    chunk rows exist but failed to embed (drift cascade, transient
  //    embedder errors) DO need retry on next boot. v1.7.2's query
  //    missed this case.
  // 2. Exclude notes recorded as 'no-embeddable-content'. Those will
  //    fail the same way next pass, so wiping their `sync.mtime`
  //    creates the infinite no-op loop the user hit.
  const unexpectedMissing = (db.prepare(`
    SELECT COUNT(*) AS n FROM nodes
    WHERE id NOT LIKE '_stub/%' ESCAPE '\\'
      AND id NOT IN (
        SELECT DISTINCT c.node_id FROM chunks c
        JOIN chunks_vec v ON c.rowid = v.rowid
        WHERE c.node_id IS NOT NULL
      )
      AND id NOT IN (SELECT DISTINCT note_id FROM failed_chunks WHERE reason = 'no-embeddable-content')
  `).get() as { n: number }).n;

  if (unexpectedMissing > 0) {
    process.stderr.write(
      `obsidian-brain: ${unexpectedMissing} notes have no successful embedding — wiping sync.mtime to retry on next boot\n`,
    );
    db.prepare(`
      DELETE FROM sync WHERE path IN (
        SELECT id FROM nodes
        WHERE id NOT LIKE '_stub/%' ESCAPE '\\'
          AND id NOT IN (
            SELECT DISTINCT c.node_id FROM chunks c
            JOIN chunks_vec v ON c.rowid = v.rowid
            WHERE c.node_id IS NOT NULL
          )
          AND id NOT IN (SELECT DISTINCT note_id FROM failed_chunks WHERE reason = 'no-embeddable-content')
      )
    `).run();
  }

  const noContentTotal = (db.prepare(
    `SELECT COUNT(DISTINCT note_id) AS n FROM failed_chunks WHERE reason = 'no-embeddable-content'`,
  ).get() as { n: number }).n;
  if (noContentTotal > 0) {
    process.stderr.write(
      `obsidian-brain: ${noContentTotal} notes have no embeddable content (empty / frontmatter-only / sub-minChunkChars body) — recorded as 'no-embeddable-content' in failed_chunks; will not retry until the file changes\n`,
    );
  }

  return { unexpectedMissing, noContentTotal };
}
