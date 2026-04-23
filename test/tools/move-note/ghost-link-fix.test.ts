import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, type DatabaseHandle } from '../../../src/store/db.js';
import { upsertNode } from '../../../src/store/nodes.js';
import { insertEdge } from '../../../src/store/edges.js';
import { moveNote } from '../../../src/vault/mover.js';
import { rewriteInboundLinks } from '../../../src/tools/move-note.js';

/**
 * Regression tests for v1.6.2 — `move_note` ghost-link fix.
 *
 * Field symptom: rename BMW.md → `BMW & Audi.md`, but `Cars.md` (which held
 * `[[BMW]]`) stayed unchanged on disk and the graph kept a dangling edge
 * Cars → _stub/BMW.md. Two root causes:
 *
 *  (a) `rewriteInboundLinks` only queried `getEdgesByTarget(db, oldPath)`,
 *      so inbound edges still targeting `_stub/${oldStem}.md` (leftovers
 *      from forward-ref timing or pre-v1.5.8 state) were silently skipped.
 *  (b) `indexSingleNote` — the watcher's per-file path — didn't call
 *      `migrateStubToReal` when a real note arrived with a pre-existing
 *      forward-ref stub.
 *
 * The fix merges `_stub/${oldStem}.md` into the inbound-edge lookup and
 * wires `indexSingleNote` to migrate forward-stubs the same way
 * `create_note` does.
 */
describe('move_note ghost-link fix (v1.6.2)', () => {
  let vault: string;
  let db: DatabaseHandle;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'kg-v1-6-2-'));
    db = openDb(':memory:');
  });

  afterEach(async () => {
    db.close();
    await rm(vault, { recursive: true, force: true });
  });

  it('rewriteInboundLinks finds source files whose edge targets _stub/<oldStem>.md', async () => {
    await writeFile(join(vault, 'BMW.md'), '# BMW\n', 'utf-8');
    await writeFile(join(vault, 'Cars.md'), 'I drive a [[BMW]] every day.\n', 'utf-8');

    upsertNode(db, { id: 'BMW.md', title: 'BMW', content: '', frontmatter: {} });
    upsertNode(db, { id: 'Cars.md', title: 'Cars', content: '', frontmatter: {} });
    upsertNode(db, {
      id: '_stub/BMW.md',
      title: 'BMW',
      content: '',
      frontmatter: { _stub: true },
    });
    insertEdge(db, { sourceId: 'Cars.md', targetId: '_stub/BMW.md', context: 'link' });

    const move = await moveNote(vault, 'BMW.md', 'BMW & Audi.md');

    const report = await rewriteInboundLinks(db, vault, move.oldPath, move.newPath);

    expect(report.files).toBe(1);
    expect(report.occurrences).toBe(1);
    expect(report.rewrittenSources).toEqual(['Cars.md']);

    expect(await readFile(join(vault, 'Cars.md'), 'utf-8')).toBe(
      'I drive a [[BMW & Audi]] every day.\n',
    );
  });

  it('combines real-target and stub-target inbound edges without double-counting the same source', async () => {
    await writeFile(join(vault, 'target.md'), '# Target\n', 'utf-8');
    await writeFile(
      join(vault, 'source.md'),
      'Real-target [[target]] and stub-target [[target]] again.\n',
      'utf-8',
    );

    upsertNode(db, { id: 'target.md', title: 'Target', content: '', frontmatter: {} });
    upsertNode(db, { id: 'source.md', title: 'Source', content: '', frontmatter: {} });
    insertEdge(db, { sourceId: 'source.md', targetId: 'target.md', context: 'link' });
    upsertNode(db, {
      id: '_stub/target.md',
      title: 'target',
      content: '',
      frontmatter: { _stub: true },
    });
    insertEdge(db, { sourceId: 'source.md', targetId: '_stub/target.md', context: 'link' });

    const move = await moveNote(vault, 'target.md', 'renamed.md');
    const report = await rewriteInboundLinks(db, vault, move.oldPath, move.newPath);

    // Source rewritten once (Set dedup), occurrences counts both hits.
    expect(report.files).toBe(1);
    expect(report.occurrences).toBe(2);
    expect(report.rewrittenSources).toEqual(['source.md']);
  });
});
