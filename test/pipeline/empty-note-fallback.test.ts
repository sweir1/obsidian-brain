/**
 * v1.7.3 regression tests — title-fallback for content-less notes (F1).
 *
 * Pre-v1.7.3, notes whose body produced zero chunks (empty file, frontmatter-
 * only, embeds-only, sub-`minChunkChars` body) were silently dropped: chunks
 * was empty → no `chunks_vec` rows → invisible to `index_status`'s JOIN.
 * For Obsidian vaults full of daily-note stubs and MOCs this caused the
 * user-reported 32% "missing embeddings" report.
 *
 * v1.7.3 synthesises a fallback chunk from title + tags + frontmatter scalars
 * + first 5 wikilink targets so the note is searchable by name.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { bootstrap } from '../../src/pipeline/bootstrap.js';
import { IndexPipeline } from '../../src/pipeline/indexer.js';
import { InstantMockEmbedder } from '../helpers/mock-embedders.js';

function mkVault(): string {
  return mkdtempSync(join(tmpdir(), 'obs-brain-fallback-'));
}

function writeNote(vault: string, name: string, content: string): void {
  writeFileSync(join(vault, name), content, 'utf8');
}

function countChunkVecRows(db: DatabaseHandle, nodeId: string): number {
  return (db.prepare(
    `SELECT COUNT(*) AS n FROM chunks c
     JOIN chunks_vec v ON c.rowid = v.rowid
     WHERE c.node_id = ?`,
  ).get(nodeId) as { n: number }).n;
}

describe('IndexPipeline — v1.7.3 title-fallback (F1)', () => {
  let db: DatabaseHandle;
  let vault: string;

  beforeEach(() => {
    db = openDb(':memory:');
    bootstrap(db, new InstantMockEmbedder());
    vault = mkVault();
  });

  afterEach(() => {
    db.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it('empty note → fallback chunk indexed (filename stem becomes searchable text)', async () => {
    writeNote(vault, 'just-a-stub.md', '');
    const pipeline = new IndexPipeline(db, new InstantMockEmbedder());
    const stats = await pipeline.index(vault);

    expect(stats.nodesIndexed).toBe(1);
    expect(countChunkVecRows(db, 'just-a-stub.md')).toBe(1);
    expect(stats.notesMissingEmbeddings).toBe(0);

    // The fallback chunk's content should include the filename stem.
    const chunkContent = (db.prepare(
      "SELECT content FROM chunks WHERE node_id = 'just-a-stub.md'",
    ).get() as { content: string }).content;
    expect(chunkContent).toContain('just-a-stub');
  });

  it('frontmatter-only note → fallback chunk includes scalar values', async () => {
    writeNote(vault, 'meta.md', '---\nstatus: in-progress\nyear: 2026\n---\n');
    const pipeline = new IndexPipeline(db, new InstantMockEmbedder());
    await pipeline.index(vault);

    expect(countChunkVecRows(db, 'meta.md')).toBe(1);
    const chunkContent = (db.prepare(
      "SELECT content FROM chunks WHERE node_id = 'meta.md'",
    ).get() as { content: string }).content;
    expect(chunkContent).toContain('status: in-progress');
    expect(chunkContent).toContain('year: 2026');
  });

  it('daily-note pattern (`# 2026-04-25` only) → fallback chunk indexed', async () => {
    // Daily notes typically open empty under a single H1 heading. The H1
    // line alone is below `minChunkChars=50` so chunkMarkdown returns [].
    writeNote(vault, '2026-04-25.md', '# 2026-04-25\n');
    const pipeline = new IndexPipeline(db, new InstantMockEmbedder());
    await pipeline.index(vault);

    expect(countChunkVecRows(db, '2026-04-25.md')).toBe(1);
  });

  it('embeds-only note → fallback chunk lists embed targets', async () => {
    writeNote(vault, 'gallery.md', '![[image1.png]] ![[image2.png]] ![[image3.png]]\n');
    const pipeline = new IndexPipeline(db, new InstantMockEmbedder());
    await pipeline.index(vault);

    expect(countChunkVecRows(db, 'gallery.md')).toBe(1);
    const chunkContent = (db.prepare(
      "SELECT content FROM chunks WHERE node_id = 'gallery.md'",
    ).get() as { content: string }).content;
    expect(chunkContent).toContain('image1.png');
    expect(chunkContent).toContain('image2.png');
    expect(chunkContent).toContain('image3.png');
  });

  it('multiple empty notes → all get fallback chunks (the user\'s 32% case)', async () => {
    for (let i = 0; i < 10; i++) writeNote(vault, `daily-${i}.md`, '');
    const pipeline = new IndexPipeline(db, new InstantMockEmbedder());
    const stats = await pipeline.index(vault);

    expect(stats.nodesIndexed).toBe(10);
    expect(stats.notesMissingEmbeddings).toBe(0);

    const indexedCount = (db.prepare(
      `SELECT COUNT(DISTINCT node_id) AS n FROM chunks
       JOIN chunks_vec ON chunks.rowid = chunks_vec.rowid`,
    ).get() as { n: number }).n;
    expect(indexedCount).toBe(10);
  });

  it('empty note then real content → fallback chunk is replaced by real chunks', async () => {
    writeNote(vault, 'evolves.md', '');
    const pipeline1 = new IndexPipeline(db, new InstantMockEmbedder());
    await pipeline1.index(vault);
    expect(countChunkVecRows(db, 'evolves.md')).toBe(1);

    // User adds real body → next reindex produces real chunks instead of fallback.
    writeNote(vault, 'evolves.md',
      '# Heading One\n\nThis paragraph has enough content to pass the minimum chunk character threshold.\n\n' +
      '# Heading Two\n\nAnother paragraph that exceeds the minimum chunk character threshold of fifty.\n');
    const pipeline2 = new IndexPipeline(db, new InstantMockEmbedder());
    await pipeline2.index(vault);

    // Now there should be ≥2 real chunks (one per heading section).
    expect(countChunkVecRows(db, 'evolves.md')).toBeGreaterThanOrEqual(2);
  });
});
