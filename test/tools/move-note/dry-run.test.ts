import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, type DatabaseHandle } from '../../../src/store/db.js';
import { upsertNode, allNodeIds } from '../../../src/store/nodes.js';
import { insertEdge } from '../../../src/store/edges.js';
import { registerMoveNoteTool } from '../../../src/tools/move-note.js';
import type { ServerContext } from '../../../src/context.js';
import { makeMockServer, unwrap } from '../../helpers/mock-server.js';

/**
 * dryRun=true on move_note must return a preview without touching disk or DB.
 */
describe('move_note dryRun=true returns preview without mutating (v1.6.0-C)', () => {
  let vault: string;
  let db: DatabaseHandle;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'kg-move-dryrun-'));
    db = openDb(':memory:');
  });

  afterEach(async () => {
    db.close();
    await rm(vault, { recursive: true, force: true });
  });

  function buildCtx(): ServerContext {
    return {
      db,
      config: { vaultPath: vault },
      ensureEmbedderReady: async () => {},
      pipeline: { index: async () => undefined },
    } as unknown as ServerContext;
  }

  it('with dryRun=true returns preview without mutating', async () => {
    await writeFile(join(vault, 'alpha.md'), '# Alpha\n', 'utf-8');
    await writeFile(join(vault, 'ref.md'), 'See [[alpha]] for details.\n', 'utf-8');

    upsertNode(db, { id: 'alpha.md', title: 'Alpha', content: '', frontmatter: {} });
    upsertNode(db, { id: 'ref.md', title: 'Ref', content: '', frontmatter: {} });
    insertEdge(db, { sourceId: 'ref.md', targetId: 'alpha.md', context: 'link' });

    const beforeDisk = await readFile(join(vault, 'ref.md'), 'utf-8');
    const beforeNodes = allNodeIds(db).slice().sort();

    const { server, registered } = makeMockServer();
    registerMoveNoteTool(server, buildCtx());
    const tool = registered.find((t) => t.name === 'move_note')!;

    const payload = unwrap(
      await tool.cb({ source: 'alpha.md', destination: 'beta', dryRun: true }),
    );

    expect(payload.dryRun).toBe(true);
    expect(payload.oldPath).toBe('alpha.md');
    expect(payload.newPath).toBe('beta.md');
    expect(payload.totalFiles).toBe(1);
    expect(payload.totalOccurrences).toBe(1);
    expect(payload.linksToRewrite).toHaveLength(1);
    expect(payload.linksToRewrite[0].file).toBe('ref.md');
    expect(payload.linksToRewrite[0].occurrences).toBe(1);

    const afterDisk = await readFile(join(vault, 'ref.md'), 'utf-8');
    expect(afterDisk).toBe(beforeDisk);

    await expect(readFile(join(vault, 'alpha.md'), 'utf-8')).resolves.toBeDefined();

    const afterNodes = allNodeIds(db).slice().sort();
    expect(afterNodes).toEqual(beforeNodes);
  });
});
