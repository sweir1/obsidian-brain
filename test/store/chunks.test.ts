import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { upsertNode, deleteNode } from '../../src/store/nodes.js';
import {
  upsertChunkRow,
  upsertChunkVector,
  getChunk,
  getChunkIdsForNode,
  deleteChunks,
  deleteChunksForNode,
  countChunks,
  searchChunkVectors,
} from '../../src/store/chunks.js';
import type { Chunk } from '../../src/embeddings/chunker.js';

function fakeChunk(i: number, heading = 'H', content = 'body body'): Chunk {
  return {
    chunkIndex: i,
    heading,
    headingLevel: 1,
    content,
    contentHash: `hash-${i}`,
    startLine: i + 1,
    endLine: i + 2,
  };
}

function mkEmb(seed = 0, dim = 384): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.sin(i * 0.1 + seed);
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

describe('store/chunks', () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDb(':memory:');
    upsertNode(db, { id: 'a.md', title: 'A', content: 'content A', frontmatter: {} });
    upsertNode(db, { id: 'b.md', title: 'B', content: 'content B', frontmatter: {} });
  });

  afterEach(() => {
    db.close();
  });

  it('upserts a chunk row and retrieves it', () => {
    const rowid = upsertChunkRow(db, 'a.md', fakeChunk(0));
    expect(rowid).toBeGreaterThan(0);
    const c = getChunk(db, 'a.md::0');
    expect(c).toBeDefined();
    expect(c!.nodeId).toBe('a.md');
    expect(c!.chunkIndex).toBe(0);
    expect(c!.contentHash).toBe('hash-0');
  });

  it('getChunk returns undefined for missing ids', () => {
    expect(getChunk(db, 'nope::0')).toBeUndefined();
  });

  it('upsertChunkRow replaces on conflict', () => {
    upsertChunkRow(db, 'a.md', fakeChunk(0, 'Old', 'old body'));
    upsertChunkRow(db, 'a.md', { ...fakeChunk(0, 'New', 'new body'), contentHash: 'hash-new' });
    const c = getChunk(db, 'a.md::0');
    expect(c!.heading).toBe('New');
    expect(c!.contentHash).toBe('hash-new');
  });

  it('getChunkIdsForNode returns sequential ids for one node', () => {
    upsertChunkRow(db, 'a.md', fakeChunk(0));
    upsertChunkRow(db, 'a.md', fakeChunk(1));
    upsertChunkRow(db, 'a.md', fakeChunk(2));
    upsertChunkRow(db, 'b.md', fakeChunk(0));
    expect(getChunkIdsForNode(db, 'a.md')).toEqual(['a.md::0', 'a.md::1', 'a.md::2']);
    expect(getChunkIdsForNode(db, 'b.md')).toEqual(['b.md::0']);
  });

  it('deleteChunks removes rows and vector rows', () => {
    const rid = upsertChunkRow(db, 'a.md', fakeChunk(0));
    upsertChunkVector(db, rid, mkEmb(0));
    upsertChunkRow(db, 'a.md', fakeChunk(1));
    deleteChunks(db, ['a.md::0']);
    expect(getChunk(db, 'a.md::0')).toBeUndefined();
    expect(getChunk(db, 'a.md::1')).toBeDefined();
    // vector row is also gone.
    const vec = db.prepare('SELECT COUNT(*) AS n FROM chunks_vec WHERE rowid = ?').get(BigInt(rid)) as { n: number };
    expect(vec.n).toBe(0);
  });

  it('deleteChunksForNode wipes everything for one node', () => {
    const r0 = upsertChunkRow(db, 'a.md', fakeChunk(0));
    const r1 = upsertChunkRow(db, 'a.md', fakeChunk(1));
    upsertChunkVector(db, r0, mkEmb(0));
    upsertChunkVector(db, r1, mkEmb(1));
    upsertChunkRow(db, 'b.md', fakeChunk(0));
    deleteChunksForNode(db, 'a.md');
    expect(getChunkIdsForNode(db, 'a.md')).toEqual([]);
    expect(getChunkIdsForNode(db, 'b.md')).toEqual(['b.md::0']);
  });

  it('countChunks reports total rows', () => {
    expect(countChunks(db)).toBe(0);
    upsertChunkRow(db, 'a.md', fakeChunk(0));
    upsertChunkRow(db, 'a.md', fakeChunk(1));
    expect(countChunks(db)).toBe(2);
  });

  it('deleteNode cascades to chunks + chunks_vec', () => {
    const rid = upsertChunkRow(db, 'a.md', fakeChunk(0));
    upsertChunkVector(db, rid, mkEmb(0));
    deleteNode(db, 'a.md');
    expect(getChunkIdsForNode(db, 'a.md')).toEqual([]);
    const vec = db.prepare('SELECT COUNT(*) AS n FROM chunks_vec WHERE rowid = ?').get(BigInt(rid)) as { n: number };
    expect(vec.n).toBe(0);
  });

  it('searchChunkVectors finds the nearest chunk', () => {
    const v0 = mkEmb(0);
    const v1 = mkEmb(5);
    const r0 = upsertChunkRow(db, 'a.md', fakeChunk(0));
    const r1 = upsertChunkRow(db, 'b.md', fakeChunk(0));
    upsertChunkVector(db, r0, v0);
    upsertChunkVector(db, r1, v1);
    const hits = searchChunkVectors(db, v0, 5);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].nodeId).toBe('a.md');
    expect(hits[0].score).toBeGreaterThan(0.99);
  });
});
