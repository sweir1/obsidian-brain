/**
 * v1.7.3 regression tests — index_status three-bucket reporting (F4).
 *
 * Pre-v1.7.3, `notesMissingEmbeddings = notesTotal - notesWithEmbeddings`
 * conflated "no body to embed" (frontmatter-only daily notes) with
 * "embedder failed". MCP clients (Claude) read this and reported
 * "1,228 missing" when most of those had nothing embeddable in the first
 * place.
 *
 * v1.7.3 adds `notesNoEmbeddableContent` — distinct count of notes
 * recorded in `failed_chunks` with reason `'no-embeddable-content'`.
 * The remaining `notesMissingEmbeddings` are genuine failures.
 * `notesIndexed + notesNoEmbeddableContent + notesMissingEmbeddings`
 * sums to `notesTotal` (when all 3 buckets are well-formed).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { upsertNode } from '../../src/store/nodes.js';
import { upsertChunkRow, upsertChunkVector } from '../../src/store/chunks.js';
import { recordFailedChunk } from '../../src/embeddings/capacity.js';
import { registerIndexStatusTool } from '../../src/tools/index-status.js';
import { InstantMockEmbedder } from '../helpers/mock-embedders.js';
import { makeMockServer, unwrap } from '../helpers/mock-server.js';
import type { ServerContext } from '../../src/context.js';

function buildCtx(db: DatabaseHandle): ServerContext {
  const embedder = new InstantMockEmbedder();
  return {
    db,
    embedder,
    embedderReady: () => true,
    initError: undefined,
    getBootstrap: () => null,
    pendingReindex: Promise.resolve(),
    reindexInProgress: false,
    search: undefined,
    writer: undefined,
    pipeline: undefined,
    config: { vaultPath: '/fake' },
    obsidian: undefined,
    ensureEmbedderReady: async () => {},
    enqueueBackgroundReindex: () => {},
  } as unknown as ServerContext;
}

function seedIndexedNote(db: DatabaseHandle, id: string): void {
  upsertNode(db, { id, title: id.replace('.md', ''), content: 'body', frontmatter: {} });
  const rowid = upsertChunkRow(db, id, {
    chunkIndex: 0,
    heading: null,
    headingLevel: null,
    content: 'body',
    contentHash: 'hash-' + id,
    startLine: 0,
    endLine: 0,
  });
  upsertChunkVector(db, rowid, new Float32Array(384));
}

function seedNoContentNote(db: DatabaseHandle, id: string): void {
  upsertNode(db, { id, title: id.replace('.md', ''), content: '', frontmatter: {} });
  recordFailedChunk(db, `${id}#no-content`, id, 'no-embeddable-content', null);
}

function seedFailedNote(db: DatabaseHandle, id: string): void {
  // A chunk row exists (so the chunker did emit something) but no vec entry.
  upsertNode(db, { id, title: id.replace('.md', ''), content: 'body', frontmatter: {} });
  upsertChunkRow(db, id, {
    chunkIndex: 0,
    heading: null,
    headingLevel: null,
    content: 'body too long for embedder',
    contentHash: 'hash-' + id,
    startLine: 0,
    endLine: 0,
  });
  // No upsertChunkVector — embed failed. Record the failure.
  recordFailedChunk(db, `${id}::0`, id, 'too-long', 'input length exceeds context length');
}

describe('index_status v1.7.3 — three buckets', () => {
  let db: DatabaseHandle;
  beforeEach(() => { db = openDb(':memory:'); });
  afterEach(() => { db.close(); });

  it('healthy vault with mixed buckets reports each correctly', async () => {
    for (let i = 0; i < 3; i++) seedIndexedNote(db, `indexed-${i}.md`);
    for (let i = 0; i < 2; i++) seedNoContentNote(db, `empty-${i}.md`);
    seedFailedNote(db, 'failed-0.md');

    const { server, registered } = makeMockServer();
    registerIndexStatusTool(server, buildCtx(db));
    const result = unwrap(await registered[0].cb({}));

    expect(result.notesTotal).toBe(6);
    expect(result.notesWithEmbeddings).toBe(3);
    expect(result.notesNoEmbeddableContent).toBe(2);
    expect(result.notesMissingEmbeddings).toBe(1);
    // Sum check: 3 indexed + 2 no-content + 1 failed = 6 total.
    expect(
      result.notesWithEmbeddings + result.notesNoEmbeddableContent + result.notesMissingEmbeddings,
    ).toBe(result.notesTotal);
  });

  it('summary string mentions each non-zero bucket', async () => {
    seedIndexedNote(db, 'a.md');
    seedNoContentNote(db, 'b.md');
    seedFailedNote(db, 'c.md');

    const { server, registered } = makeMockServer();
    registerIndexStatusTool(server, buildCtx(db));
    const result = unwrap(await registered[0].cb({}));

    expect(result.summary).toContain('1 / 3');
    expect(result.summary).toMatch(/no embeddable content/);
    expect(result.summary).toMatch(/failed/);
  });

  it('happy path — all indexed → notesNoEmbeddableContent and notesMissingEmbeddings both 0', async () => {
    for (let i = 0; i < 5; i++) seedIndexedNote(db, `n-${i}.md`);

    const { server, registered } = makeMockServer();
    registerIndexStatusTool(server, buildCtx(db));
    const result = unwrap(await registered[0].cb({}));

    expect(result.notesTotal).toBe(5);
    expect(result.notesWithEmbeddings).toBe(5);
    expect(result.notesNoEmbeddableContent).toBe(0);
    expect(result.notesMissingEmbeddings).toBe(0);
  });

  it('vault that is all daily-note stubs (the user\'s case) — none counted as missing', async () => {
    // The user reported 1,228 / 3,867 "missing" before v1.7.3. Most were
    // daily notes the chunker dropped. With v1.7.3 they get fallback chunks
    // (test in empty-note-fallback.test.ts); here we simulate the worst
    // case where even the fallback is unavailable (truly content-less) — they
    // should land in notesNoEmbeddableContent, not notesMissingEmbeddings.
    for (let i = 0; i < 100; i++) seedNoContentNote(db, `stub-${i}.md`);

    const { server, registered } = makeMockServer();
    registerIndexStatusTool(server, buildCtx(db));
    const result = unwrap(await registered[0].cb({}));

    expect(result.notesTotal).toBe(100);
    expect(result.notesWithEmbeddings).toBe(0);
    expect(result.notesNoEmbeddableContent).toBe(100);
    expect(result.notesMissingEmbeddings).toBe(0);
  });
});
