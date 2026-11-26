import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { bootstrap } from '../../src/pipeline/bootstrap.js';
import { IndexPipeline } from '../../src/pipeline/indexer.js';
import { pruneSeparatorDuplicates } from '../../src/pipeline/indexer/separator-cleanup.js';
import { allNodeIds, getNode, upsertNode } from '../../src/store/nodes.js';
import { getEdgesByTarget, insertEdge } from '../../src/store/edges.js';
import { getSyncMtime, setSyncMtime } from '../../src/store/sync.js';
import { InstantMockEmbedder } from '../helpers/mock-embedders.js';

/**
 * Issue #44: older Windows watcher sessions left `\`-separated duplicate
 * rows (`_logs\x.md` next to `_logs/x.md`). The full reindex now removes
 * them, moving inbound links to the "/" twin first.
 */

let db: DatabaseHandle;

function note(id: string, extra: Record<string, unknown> = {}) {
  upsertNode(db, { id, title: id, content: `# ${id}`, frontmatter: extra });
}

beforeEach(() => {
  db = openDb(':memory:');
  bootstrap(db, new InstantMockEmbedder());
});

afterEach(() => {
  db.close();
});

describe('pruneSeparatorDuplicates', () => {
  it('removes a backslash duplicate and repoints its inbound links to the "/" twin', () => {
    note('_logs/x.md');
    note('_logs\\x.md');
    note('b.md');
    setSyncMtime(db, '_logs\\x.md', 1);
    insertEdge(db, { sourceId: 'b.md', targetId: '_logs\\x.md', context: 'see [[x]]' });
    insertEdge(db, { sourceId: '_logs\\x.md', targetId: 'b.md', context: 'dup out-link' });

    const removed = pruneSeparatorDuplicates(db, new Set(['_logs/x.md', 'b.md']));

    expect(removed).toBe(1);
    expect(getNode(db, '_logs\\x.md')).toBeUndefined();
    expect(getSyncMtime(db, '_logs\\x.md')).toBeUndefined();
    expect(getEdgesByTarget(db, '_logs/x.md').map((e) => e.sourceId)).toEqual(['b.md']);
    expect(getEdgesByTarget(db, 'b.md')).toEqual([]);
    expect(getNode(db, '_logs/x.md')).toBeDefined();
  });

  it('removes a backslash row whose file is gone (no twin) like any deleted note', () => {
    note('gone\\x.md');
    expect(pruneSeparatorDuplicates(db, new Set())).toBe(1);
    expect(allNodeIds(db)).toEqual([]);
  });

  it('keeps a backslash id the scan produced (legal filename character on POSIX)', () => {
    note('odd\\name.md');
    expect(pruneSeparatorDuplicates(db, new Set(['odd\\name.md']))).toBe(0);
    expect(getNode(db, 'odd\\name.md')).toBeDefined();
  });

  it('leaves stub nodes to the orphan-stub pruning', () => {
    note('_stub/a\\b.md', { _stub: true });
    note('weird\\stub.md', { _stub: true });
    expect(pruneSeparatorDuplicates(db, new Set())).toBe(0);
    expect(allNodeIds(db).sort()).toEqual(['_stub/a\\b.md', 'weird\\stub.md']);
  });

  it('ignores ids without a backslash', () => {
    note('a/b.md');
    expect(pruneSeparatorDuplicates(db, new Set())).toBe(0);
    expect(getNode(db, 'a/b.md')).toBeDefined();
  });
});

describe('IndexPipeline.index — separator duplicates', () => {
  let vault: string;

  beforeEach(() => {
    vault = mkdtempSync(join(tmpdir(), 'ob-sepdup-'));
    mkdirSync(join(vault, '_logs'));
    writeFileSync(join(vault, '_logs', 'day.md'), '# Day\n\nSome text for the day note.\n');
    writeFileSync(join(vault, 'b.md'), '# B\n\nLinks to [[day]].\n');
  });

  afterEach(() => {
    rmSync(vault, { recursive: true, force: true });
  });

  it('prunes duplicates even when the sync table was wiped, and keeps inbound links', async () => {
    const pipeline = new IndexPipeline(db, new InstantMockEmbedder());
    await pipeline.index(vault);
    expect(getEdgesByTarget(db, '_logs/day.md').map((e) => e.sourceId)).toEqual(['b.md']);

    // Simulate a Windows watcher session: duplicate row for the same note,
    // with b.md's link resolved to the duplicate. Then the model-change
    // bootstrap wipes the sync table.
    note('_logs\\day.md');
    db.prepare('UPDATE edges SET target_id = ? WHERE target_id = ?').run('_logs\\day.md', '_logs/day.md');
    db.exec('DELETE FROM sync');

    await pipeline.index(vault);

    expect(allNodeIds(db).filter((id) => id.includes('\\'))).toEqual([]);
    expect(getEdgesByTarget(db, '_logs/day.md').map((e) => e.sourceId)).toEqual(['b.md']);
  });

  it('a stale backslash row with a sync entry keeps b.md\'s link when b.md is unchanged', async () => {
    const pipeline = new IndexPipeline(db, new InstantMockEmbedder());
    await pipeline.index(vault);

    note('_logs\\day.md');
    setSyncMtime(db, '_logs\\day.md', Date.now());
    db.prepare('UPDATE edges SET target_id = ? WHERE target_id = ?').run('_logs\\day.md', '_logs/day.md');

    const stats = await pipeline.index(vault);

    // b.md's mtime didn't change, so it isn't re-parsed — the link survives
    // only because it was moved to the "/" twin before the duplicate went.
    expect(stats.nodesIndexed).toBe(0);
    expect(getNode(db, '_logs\\day.md')).toBeUndefined();
    expect(getEdgesByTarget(db, '_logs/day.md').map((e) => e.sourceId)).toEqual(['b.md']);
  });
});
