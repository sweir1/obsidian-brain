import type { DatabaseHandle } from '../../store/db.js';
import { getNode, upsertNode, migrateStubToReal } from '../../store/nodes.js';
import { buildStemLookup, resolveLink } from '../../vault/wiki-links.js';

/**
 * Scan all stub nodes and migrate every one whose link text now resolves to
 * a real note: repoint its inbound edges to the real node and delete the
 * stub. Resolution goes through the parser's own `resolveLink`, so a stub
 * migrates under exactly the rules that would have resolved the link in the
 * first place — exact path, exact stem, then the case-insensitive fallbacks
 * (`_stub/note.md` → `Note.md`, `_stub/folder/note.md` → `Folder/Note.md`).
 *
 * `onlyStem` (optional): restrict the pass to stubs whose basename matches
 * this stem case-insensitively — the cheap form for single-note callers
 * (watcher add, create_note) that just made one note appear.
 *
 * This runs AFTER materialiseStubs so any new edges from the current index
 * pass are already stored before we attempt migration.
 */
export function resolveForwardStubs(db: DatabaseHandle, onlyStem?: string): number {
  return migrateResolvableStubs(db, onlyStem);
}

/**
 * Single-note form for callers that just made `relPath` appear (watcher add,
 * `create_note`). Only stubs whose basename matches the note's stem
 * (case-insensitively) are considered, and `relPath` counts as a real note
 * even if its node row hasn't been written yet — `create_note` writes the
 * file and migrates before the background reindex upserts the node.
 * Path-qualified and different-case stubs (`_stub/folder/note.md`,
 * `_stub/NOTE.md`) migrate too, not just the exact `_stub/<stem>.md`.
 */
export function migrateStubsForNote(db: DatabaseHandle, relPath: string): number {
  const stem = (relPath.split('/').pop() ?? '').replace(/\.md$/, '');
  if (!stem) return 0;
  return migrateResolvableStubs(db, stem, relPath);
}

function migrateResolvableStubs(db: DatabaseHandle, onlyStem?: string, extraRealPath?: string): number {
  const stubRows = db
    .prepare("SELECT id FROM nodes WHERE json_extract(frontmatter, '$._stub') = 1")
    .all() as Array<{ id: string }>;

  const wantStem = onlyStem?.toLowerCase();
  const pending: Array<{ stubId: string; raw: string }> = [];
  for (const { id: stubId } of stubRows) {
    // Stub ids no longer contain `#` or `^` — the parser splits
    // heading/anchor suffixes onto `edge.targetSubpath` before building the
    // stub id. Legacy fragment-embedded stubs still exist in upgraded
    // databases until the post-migration reindex runs, so skip them here;
    // `pruneAllOrphanStubs` cleans them up once their inbound edges are
    // rewritten. An empty raw is the legacy same-note-link stub
    // (`_stub/.md`), which never resolves.
    const raw = stubId.replace(/^_stub\//, '').replace(/\.md$/, '');
    if (raw === '' || raw.includes('#') || raw.includes('^')) continue;
    if (wantStem !== undefined && (raw.split('/').pop() ?? '').toLowerCase() !== wantStem) continue;
    pending.push({ stubId, raw });
  }
  if (pending.length === 0) return 0;

  const realIds = (
    db
      .prepare(
        "SELECT id FROM nodes WHERE frontmatter IS NULL OR json_extract(frontmatter, '$._stub') IS NULL",
      )
      .all() as Array<{ id: string }>
  ).map((r) => r.id);
  if (extraRealPath && !realIds.includes(extraRealPath)) realIds.push(extraRealPath);
  const stemLookup = buildStemLookup(realIds);
  const pathSet = new Set(realIds);
  const warned = new Set<string>();

  let migrated = 0;
  for (const { stubId, raw } of pending) {
    const hit = resolveLink(raw, stemLookup, pathSet, undefined, warned);
    if (hit) {
      migrateStubToReal(db, stubId, hit);
      migrated++;
    }
  }
  return migrated;
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
