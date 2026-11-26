import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { bootstrap } from '../../src/pipeline/bootstrap.js';
import { IndexPipeline } from '../../src/pipeline/indexer.js';
import { allNodeIds, upsertNode } from '../../src/store/nodes.js';
import { InstantMockEmbedder } from '../helpers/mock-embedders.js';

/**
 * Regression: deleted-file detection used to look only at the `sync` table.
 * Every full-reindex path (model / prefix change, schema bump, `--drop`)
 * clears `sync` first, so a note deleted — or newly excluded — while the
 * server was down was never pruned and lingered in search and the graph.
 */
describe('IndexPipeline.index — notes that vanished while sync was empty', () => {
  let db: DatabaseHandle;
  let vault: string;

  beforeEach(() => {
    db = openDb(':memory:');
    bootstrap(db, new InstantMockEmbedder());
    vault = mkdtempSync(join(tmpdir(), 'ob-ghost-'));
  });

  afterEach(() => {
    db.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it('prunes a note deleted while sync was cleared, but keeps stubs', async () => {
    writeFileSync(join(vault, 'Keep.md'), 'Links to [[Gone]] and [[Never Written]].');
    writeFileSync(join(vault, 'Gone.md'), 'about to be deleted');
    const pipeline = new IndexPipeline(db, new InstantMockEmbedder());
    await pipeline.index(vault);
    expect(allNodeIds(db)).toEqual(
      expect.arrayContaining(['Keep.md', 'Gone.md', '_stub/Never Written.md']),
    );

    // A full reindex was requested (sync wiped), then the file disappeared
    // before the next index pass ran.
    db.exec('DELETE FROM sync');
    unlinkSync(join(vault, 'Gone.md'));
    await pipeline.index(vault);

    const ids = allNodeIds(db);
    expect(ids).not.toContain('Gone.md');
    expect(ids).toContain('Keep.md');
    // The placeholder for a link to a note that was never written is not a
    // file and must survive; `[[Gone]]` now points at a fresh stub.
    expect(ids).toContain('_stub/Never Written.md');
  });

  it('prunes a note whose folder became excluded (node_modules/)', async () => {
    mkdirSync(join(vault, 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(vault, 'Real.md'), 'real note');
    writeFileSync(join(vault, 'node_modules', 'pkg', 'README.md'), 'npm readme');
    // Simulate an index built before node_modules/ was excluded.
    upsertNode(db, { id: 'node_modules/pkg/README.md', title: 'README', content: 'npm readme', frontmatter: {} });

    db.exec('DELETE FROM sync');
    await new IndexPipeline(db, new InstantMockEmbedder()).index(vault);

    const ids = allNodeIds(db);
    expect(ids).toContain('Real.md');
    expect(ids).not.toContain('node_modules/pkg/README.md');
  });
});
