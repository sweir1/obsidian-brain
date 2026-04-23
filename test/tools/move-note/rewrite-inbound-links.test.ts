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
 * Full-flow coverage for the H1 (v1.5.0) eager link rewriter: move a note on
 * disk, then let `rewriteInboundLinks` walk the edge store and rewrite every
 * source file that pointed at the old stem. We drive the pieces directly
 * rather than the MCP tool layer because the tool layer also spins the
 * embedder/indexer, which belongs to a different test tier.
 */
describe('move-note link rewrite flow (H1)', () => {
  let vault: string;
  let db: DatabaseHandle;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'kg-move-rewrite-'));
    db = openDb(':memory:');
  });

  afterEach(async () => {
    db.close();
    await rm(vault, { recursive: true, force: true });
  });

  it('rewrites a single inbound [[old]] link on move', async () => {
    await writeFile(join(vault, 'target.md'), '# Target\n', 'utf-8');
    await writeFile(
      join(vault, 'source.md'),
      'See [[target]] for context.\n',
      'utf-8',
    );

    upsertNode(db, { id: 'target.md', title: 'Target', content: '', frontmatter: {} });
    upsertNode(db, { id: 'source.md', title: 'Source', content: '', frontmatter: {} });
    insertEdge(db, { sourceId: 'source.md', targetId: 'target.md', context: 'link' });

    const move = await moveNote(vault, 'target.md', 'renamed.md');
    expect(move.newPath).toBe('renamed.md');

    const report = await rewriteInboundLinks(db, vault, move.oldPath, move.newPath);
    expect(report).toEqual({ files: 1, occurrences: 1, rewrittenSources: ['source.md'] });

    const src = await readFile(join(vault, 'source.md'), 'utf-8');
    expect(src).toBe('See [[renamed]] for context.\n');
  });

  it('reports zero when nothing links to the moved note', async () => {
    await writeFile(join(vault, 'lonely.md'), '# Lonely\n', 'utf-8');
    upsertNode(db, { id: 'lonely.md', title: 'Lonely', content: '', frontmatter: {} });

    const move = await moveNote(vault, 'lonely.md', 'still-lonely.md');
    const report = await rewriteInboundLinks(db, vault, move.oldPath, move.newPath);
    expect(report).toEqual({ files: 0, occurrences: 0, rewrittenSources: [] });
  });

  it('rewrites every variant ([[x]], ![[x]], [[x|alias]]) in one source', async () => {
    await writeFile(join(vault, 'target.md'), '# Target\n', 'utf-8');
    await writeFile(
      join(vault, 'source.md'),
      'Plain [[target]], embed ![[target]], and alias [[target|see target]] done.\n',
      'utf-8',
    );

    upsertNode(db, { id: 'target.md', title: 'Target', content: '', frontmatter: {} });
    upsertNode(db, { id: 'source.md', title: 'Source', content: '', frontmatter: {} });
    insertEdge(db, { sourceId: 'source.md', targetId: 'target.md', context: 'link' });
    insertEdge(db, { sourceId: 'source.md', targetId: 'target.md', context: 'embed' });
    insertEdge(db, { sourceId: 'source.md', targetId: 'target.md', context: 'link' });

    const move = await moveNote(vault, 'target.md', 'renamed.md');
    const report = await rewriteInboundLinks(db, vault, move.oldPath, move.newPath);
    expect(report).toEqual({ files: 1, occurrences: 3, rewrittenSources: ['source.md'] });

    const src = await readFile(join(vault, 'source.md'), 'utf-8');
    expect(src).toBe(
      'Plain [[renamed]], embed ![[renamed]], and alias [[renamed|see target]] done.\n',
    );
  });

  it('rewrites links across multiple source files', async () => {
    await writeFile(join(vault, 'target.md'), '# Target\n', 'utf-8');
    await writeFile(join(vault, 'a.md'), 'Refs [[target]] here.\n', 'utf-8');
    await writeFile(join(vault, 'b.md'), 'And [[target#Intro]] there.\n', 'utf-8');

    upsertNode(db, { id: 'target.md', title: 'Target', content: '', frontmatter: {} });
    upsertNode(db, { id: 'a.md', title: 'A', content: '', frontmatter: {} });
    upsertNode(db, { id: 'b.md', title: 'B', content: '', frontmatter: {} });
    insertEdge(db, { sourceId: 'a.md', targetId: 'target.md', context: 'link' });
    insertEdge(db, { sourceId: 'b.md', targetId: 'target.md', context: 'link' });

    const move = await moveNote(vault, 'target.md', 'renamed.md');
    const report = await rewriteInboundLinks(db, vault, move.oldPath, move.newPath);
    expect(report.files).toBe(2);
    expect(report.occurrences).toBe(2);
    expect(new Set(report.rewrittenSources)).toEqual(new Set(['a.md', 'b.md']));

    expect(await readFile(join(vault, 'a.md'), 'utf-8')).toBe(
      'Refs [[renamed]] here.\n',
    );
    expect(await readFile(join(vault, 'b.md'), 'utf-8')).toBe(
      'And [[renamed#Intro]] there.\n',
    );
  });

  it('skips rewriting when only the directory changes (stem unchanged)', async () => {
    await writeFile(join(vault, 'keep.md'), '# keep\n', 'utf-8');
    await writeFile(join(vault, 'source.md'), 'Points at [[keep]].\n', 'utf-8');

    upsertNode(db, { id: 'keep.md', title: 'keep', content: '', frontmatter: {} });
    upsertNode(db, { id: 'source.md', title: 'Source', content: '', frontmatter: {} });
    insertEdge(db, { sourceId: 'source.md', targetId: 'keep.md', context: 'link' });

    const move = await moveNote(vault, 'keep.md', 'Archive/keep.md');
    const report = await rewriteInboundLinks(db, vault, move.oldPath, move.newPath);
    expect(report).toEqual({ files: 0, occurrences: 0, rewrittenSources: [] });

    expect(await readFile(join(vault, 'source.md'), 'utf-8')).toBe(
      'Points at [[keep]].\n',
    );
  });

  it('tolerates source files that disappeared between edge-insert and rewrite', async () => {
    await writeFile(join(vault, 'target.md'), '# Target\n', 'utf-8');

    upsertNode(db, { id: 'target.md', title: 'Target', content: '', frontmatter: {} });
    upsertNode(db, { id: 'ghost.md', title: 'Ghost', content: '', frontmatter: {} });
    insertEdge(db, { sourceId: 'ghost.md', targetId: 'target.md', context: 'link' });

    const move = await moveNote(vault, 'target.md', 'renamed.md');
    const report = await rewriteInboundLinks(db, vault, move.oldPath, move.newPath);
    expect(report).toEqual({ files: 0, occurrences: 0, rewrittenSources: [] });
  });
});
