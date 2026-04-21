import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm, mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { moveNote, deleteNote } from '../../src/vault/mover.js';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { upsertNode } from '../../src/store/nodes.js';
import { insertEdge, getEdgesBySource } from '../../src/store/edges.js';
import {
  upsertEmbedding,
  searchVector,
} from '../../src/store/embeddings.js';
import { setSyncMtime, getSyncMtime } from '../../src/store/sync.js';

describe('mover - moveNote', () => {
  let vault: string;
  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'kg-mover-'));
    await mkdir(join(vault, 'Notes'), { recursive: true });
    await writeFile(join(vault, 'Notes', 'source.md'), '# source\n', 'utf-8');
  });
  afterEach(async () => rm(vault, { recursive: true, force: true }));

  it('renames a file in place (explicit destination path)', async () => {
    const result = await moveNote(vault, 'Notes/source.md', 'Notes/dest.md');
    expect(result.oldPath).toBe('Notes/source.md');
    expect(result.newPath).toBe('Notes/dest.md');

    const moved = await readFile(join(vault, 'Notes', 'dest.md'), 'utf-8');
    expect(moved).toBe('# source\n');
    // Source is gone.
    await expect(stat(join(vault, 'Notes', 'source.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('moves into a new directory, creating intermediate dirs', async () => {
    const result = await moveNote(
      vault,
      'Notes/source.md',
      'Deep/Nested/newdir/source.md',
    );
    expect(result.newPath).toBe('Deep/Nested/newdir/source.md');
    const moved = await readFile(
      join(vault, 'Deep', 'Nested', 'newdir', 'source.md'),
      'utf-8',
    );
    expect(moved).toBe('# source\n');
  });

  it('destination without extension gets .md appended', async () => {
    const result = await moveNote(vault, 'Notes/source.md', 'Notes/renamed');
    expect(result.newPath).toBe('Notes/renamed.md');
    const moved = await readFile(join(vault, 'Notes', 'renamed.md'), 'utf-8');
    expect(moved).toBe('# source\n');
  });

  it('trailing slash on destination treats it as directory, preserves filename', async () => {
    const result = await moveNote(vault, 'Notes/source.md', 'Archive/');
    expect(result.newPath).toBe('Archive/source.md');
    const moved = await readFile(join(vault, 'Archive', 'source.md'), 'utf-8');
    expect(moved).toBe('# source\n');
  });

  it('throws when source does not exist', async () => {
    await expect(moveNote(vault, 'missing.md', 'dest.md')).rejects.toThrow(
      /not found/,
    );
  });
});

describe('mover - moveNote frontmatter.title sync (F5)', () => {
  let vault: string;
  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'kg-mover-fm-'));
  });
  afterEach(async () => rm(vault, { recursive: true, force: true }));

  it('updates title when it equals the old basename', async () => {
    await writeFile(
      join(vault, 'foo.md'),
      '---\ntitle: foo\n---\n\nBody.\n',
      'utf-8',
    );
    await moveNote(vault, 'foo.md', 'bar.md');
    const moved = await readFile(join(vault, 'bar.md'), 'utf-8');
    expect(moved).toMatch(/title:\s*bar\b/);
    expect(moved).toContain('Body.');
  });

  it('leaves a custom title alone', async () => {
    await writeFile(
      join(vault, 'foo.md'),
      '---\ntitle: Custom Title\n---\n\nBody.\n',
      'utf-8',
    );
    await moveNote(vault, 'foo.md', 'bar.md');
    const moved = await readFile(join(vault, 'bar.md'), 'utf-8');
    expect(moved).toMatch(/title:\s*Custom Title/);
  });

  it('does not add a title field when none was present', async () => {
    await writeFile(
      join(vault, 'foo.md'),
      '---\ntags: [a]\n---\n\nBody.\n',
      'utf-8',
    );
    await moveNote(vault, 'foo.md', 'bar.md');
    const moved = await readFile(join(vault, 'bar.md'), 'utf-8');
    expect(moved).not.toMatch(/^title:/m);
    expect(moved).toMatch(/tags:/);
  });
});

describe('mover - deleteNote', () => {
  let vault: string;
  let db: DatabaseHandle;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'kg-mover-del-'));
    db = openDb(':memory:');
    await writeFile(join(vault, 'victim.md'), '# victim\n', 'utf-8');

    // Populate the minimal in-memory schema with a node + edges + embedding.
    upsertNode(db, {
      id: 'victim.md',
      title: 'Victim',
      content: '# victim\n',
      frontmatter: {},
    });
    upsertNode(db, {
      id: 'other.md',
      title: 'Other',
      content: '',
      frontmatter: {},
    });
    insertEdge(db, {
      sourceId: 'victim.md',
      targetId: 'other.md',
      context: 'link',
    });
    insertEdge(db, {
      sourceId: 'victim.md',
      targetId: 'other.md',
      context: 'link 2',
    });
    // Tiny embedding so we can verify it's removed.
    const v = new Float32Array(384);
    v[0] = 1;
    upsertEmbedding(db, 'victim.md', v);
    setSyncMtime(db, 'victim.md', 1234);
  });

  afterEach(async () => {
    db.close();
    await rm(vault, { recursive: true, force: true });
  });

  it('deletes the file and tears down index rows', async () => {
    const result = await deleteNote(vault, 'victim.md', db);
    expect(result.path).toBe('victim.md');
    expect(result.deletedFromIndex.node).toBe(true);
    expect(result.deletedFromIndex.edges).toBe(2);
    expect(result.deletedFromIndex.embedding).toBe(true);

    // File gone from disk.
    await expect(stat(join(vault, 'victim.md'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    // Edges cleared.
    expect(getEdgesBySource(db, 'victim.md')).toHaveLength(0);
    // Sync path cleared.
    expect(getSyncMtime(db, 'victim.md')).toBeUndefined();
    // Embedding vector cleared.
    const v = new Float32Array(384);
    v[0] = 1;
    const hits = searchVector(db, v, 10);
    expect(hits.find((h) => h.nodeId === 'victim.md')).toBeUndefined();
  });

  it('succeeds even if the file is already missing from disk', async () => {
    // Delete the file first, outside of our API.
    await rm(join(vault, 'victim.md'));
    const result = await deleteNote(vault, 'victim.md', db);
    // Index cleanup still reports success even though the unlink was a no-op.
    expect(result.deletedFromIndex.node).toBe(true);
  });
});
