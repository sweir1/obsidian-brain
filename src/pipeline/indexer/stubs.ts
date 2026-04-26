import type { DatabaseHandle } from '../../store/db.js';
import { getNode, upsertNode, migrateStubToReal } from '../../store/nodes.js';

/**
 * Scan all stub nodes. For each bare-stem stub (no `#` or `^`), look for a
 * real note whose vault-relative path ends with `${stem}.md`. If found,
 * repoint all inbound edges to the real node and delete the stub.
 *
 * This runs AFTER materialiseStubs so any new edges from the current index
 * pass are already stored before we attempt migration.
 */
export function resolveForwardStubs(db: DatabaseHandle): void {
  const rows = db
    .prepare("SELECT id FROM nodes WHERE json_extract(frontmatter, '$._stub') = 1")
    .all() as Array<{ id: string }>;

  for (const { id: stubId } of rows) {
    // Stub ids no longer contain `#` or `^` as of v1.6.5 — the parser
    // splits heading/anchor suffixes onto `edge.targetSubpath` (stored
    // as target_subpath column; was target_fragment pre-v1.6.11) before
    // building the stub id. Legacy fragment-embedded stubs (pre-v1.6.5)
    // still exist in upgraded databases until the post-migration
    // reindex runs, so skip them here; `pruneAllOrphanStubs` cleans
    // them up once their inbound edges are rewritten.
    const raw = stubId.replace(/^_stub\//, '').replace(/\.md$/, '');
    if (raw.includes('#') || raw.includes('^')) continue;

    // Find a real node whose id is exactly `${raw}.md` or ends with `/${raw}.md`
    // (i.e., the note exists as a top-level or nested file with that basename).
    const want = `${raw}.md`;
    const hit = db
      .prepare(
        "SELECT id FROM nodes WHERE (id = ? OR id LIKE ?) AND (frontmatter IS NULL OR json_extract(frontmatter, '$._stub') IS NULL) LIMIT 1"
      )
      .get(want, `%/${want}`) as { id: string } | undefined;

    if (hit) {
      migrateStubToReal(db, stubId, hit.id);
    }
  }
}

export function materialiseStubs(db: DatabaseHandle, stubIds: Set<string>): number {
  let created = 0;
  for (const stubId of stubIds) {
    if (!getNode(db, stubId)) {
      upsertNode(db, {
        id: stubId,
        title: stubId.replace('_stub/', '').replace('.md', ''),
        content: '',
        frontmatter: { _stub: true },
      });
      created++;
    }
  }
  return created;
}
