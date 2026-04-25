/**
 * Regression tests for v1.7.2 P0 hotfix:
 *   F1 — guard the note-level embed (silent 33% skip)
 *   F6 — end-of-reindex self-heal (wipe sync.mtime for notes with no chunks)
 *   F4 — top-level SQL error classifier
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { bootstrap } from '../../src/pipeline/bootstrap.js';
import { IndexPipeline } from '../../src/pipeline/indexer.js';
import { getSyncMtime } from '../../src/store/sync.js';
import type { Embedder } from '../../src/embeddings/types.js';
import { InstantMockEmbedder } from '../helpers/mock-embedders.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SECTION_FILLER = 'This section has enough content to pass the minimum chunk character threshold.';

function makeMultiSectionNote(numSections: number): string {
  return Array.from({ length: numSections }, (_, i) =>
    `# Section ${i + 1}\n\n${SECTION_FILLER}\n`,
  ).join('\n');
}

function makeTmpVault(): string {
  return mkdtempSync(join(tmpdir(), 'obs-brain-recovery-'));
}

function writeNote(vaultPath: string, name: string, content: string): void {
  writeFileSync(join(vaultPath, name), content, 'utf8');
}

/**
 * Embedder that throws on the note-level embed call for a specific node id.
 * Chunk-level embeds always succeed (they come before the note-level call in
 * applyNode). We detect the note-level call because buildEmbeddingText produces
 * text that starts with the note title (the filename stem, e.g. "failing-note"),
 * whereas chunk texts are built by buildChunkEmbeddingText which starts with
 * the heading or chunk content — they do NOT start with the bare file stem.
 */
class NoteEmbedFailEmbedder extends InstantMockEmbedder {
  readonly failedTexts: string[] = [];

  constructor(private readonly noteIdStem: string, private readonly errorMsg: string) {
    super();
  }

  override async embed(text: string, taskType?: 'document' | 'query'): Promise<Float32Array> {
    // buildEmbeddingText() returns: "<title>\n<tags?>\n<firstParagraph>"
    // The title is the filename stem. So the note-level embed text starts with
    // exactly the stem string followed by a newline (or end of string).
    if (text.startsWith(this.noteIdStem + '\n') || text === this.noteIdStem) {
      this.failedTexts.push(text);
      throw new Error(this.errorMsg);
    }
    return super.embed(text, taskType);
  }
}

/**
 * Embedder where ALL embed() calls fail (for self-heal scenario where a note
 * ends up with 0 chunks).
 */
class AllChunksFailEmbedder extends InstantMockEmbedder {
  constructor(private readonly errorMsg: string) {
    super();
  }

  override async embed(_text: string, _taskType?: 'document' | 'query'): Promise<Float32Array> {
    throw new Error(this.errorMsg);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IndexPipeline — v1.7.2 reindex recovery (F1 / F4 / F6)', () => {
  let db: DatabaseHandle;
  let tmpVault: string;

  beforeEach(() => {
    db = openDb(':memory:');
    bootstrap(db, new InstantMockEmbedder());
    tmpVault = makeTmpVault();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpVault, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // F1 — Note-level embed fails on a single note
  // -------------------------------------------------------------------------

  it('F1: note-level embed throws → rest of vault indexes, failed_chunks has #note row', async () => {
    // Two notes: one will fail at note-level embed, one must succeed fully.
    writeNote(tmpVault, 'failing-note.md', makeMultiSectionNote(2));
    writeNote(tmpVault, 'passing-note.md', makeMultiSectionNote(2));

    const embedder = new NoteEmbedFailEmbedder(
      'failing-note',
      'input length exceeds context length',
    );
    const pipeline = new IndexPipeline(db, embedder);
    const stats = await pipeline.index(tmpVault);

    // The vault as a whole still finished (no throw).
    expect(stats.nodesIndexed).toBe(2);

    // The failing note must have had its note-level embed attempted.
    expect(embedder.failedTexts.length).toBeGreaterThan(0);

    // failed_chunks table must contain a row for `failing-note.md#note`.
    const failRow = db
      .prepare("SELECT * FROM failed_chunks WHERE chunk_id = 'failing-note.md#note'")
      .get() as { chunk_id: string; reason: string } | undefined;
    expect(failRow).toBeDefined();
    expect(failRow?.reason).toMatch(/note-too-long|note-embed-error/);
  });

  it('F1: note-level embed throws → setSyncMtime IS called for the failing note', async () => {
    writeNote(tmpVault, 'mtime-fail-note.md', makeMultiSectionNote(1));

    const embedder = new NoteEmbedFailEmbedder(
      'mtime-fail-note',
      'input length exceeds context length',
    );
    const pipeline = new IndexPipeline(db, embedder);
    await pipeline.index(tmpVault);

    // sync.mtime must be present even though note-level embed failed.
    const mtime = getSyncMtime(db, 'mtime-fail-note.md');
    expect(mtime).toBeDefined();
    expect(typeof mtime).toBe('number');
  });

  it('F1: note-level embed throws with dead-embedder error → re-throws out of index()', async () => {
    writeNote(tmpVault, 'dead-note.md', makeMultiSectionNote(1));

    // AlwaysFailEmbedder-style but targeting the note-level embed only won't
    // trigger dead-embedder at chunk level — use a real always-fail embedder.
    const embedder = new AllChunksFailEmbedder('connect ECONNREFUSED 127.0.0.1:11434');
    const pipeline = new IndexPipeline(db, embedder);

    await expect(pipeline.index(tmpVault)).rejects.toThrow('ECONNREFUSED');
  });

  // -------------------------------------------------------------------------
  // F6 — End-of-reindex self-heal
  // -------------------------------------------------------------------------

  it('F6 v1.7.3: empty note + failing embedder → fallback chunk row exists but no chunks_vec → self-heal wipes sync', async () => {
    // v1.7.3 — empty content goes through the title-fallback path: a synth
    // chunk is built from the filename stem. NoteEmbedFailEmbedder rejects
    // any text starting with the stem, so the chunk-level embed throws too.
    // Result: 1 row in `chunks` for the fallback, 0 rows in `chunks_vec`.
    // The new F6 query (chunks JOIN chunks_vec) correctly identifies this
    // as missing and wipes sync.mtime for next-boot retry.
    writeNote(tmpVault, 'empty-note.md', '');

    const embedder = new NoteEmbedFailEmbedder('empty-note', 'input length exceeds context length');
    const pipeline = new IndexPipeline(db, embedder);
    const stats = await pipeline.index(tmpVault);

    expect(stats.notesMissingEmbeddings).toBe(1);
    const mtime = getSyncMtime(db, 'empty-note.md');
    expect(mtime).toBeUndefined();
  });

  it('F6 v1.7.3: after self-heal wipe, second index with passing embedder recovers the note', async () => {
    writeNote(tmpVault, 'recover-note.md', '');

    const failingEmbedder = new NoteEmbedFailEmbedder('recover-note', 'input length exceeds context length');
    const pipeline1 = new IndexPipeline(db, failingEmbedder);
    const stats1 = await pipeline1.index(tmpVault);

    expect(stats1.notesMissingEmbeddings).toBe(1);
    expect(getSyncMtime(db, 'recover-note.md')).toBeUndefined();

    // Second pass — passing embedder + real content → note gets chunks and sync.mtime.
    writeNote(tmpVault, 'recover-note.md', makeMultiSectionNote(2));
    const passingEmbedder = new InstantMockEmbedder();
    const pipeline2 = new IndexPipeline(db, passingEmbedder);
    const stats2 = await pipeline2.index(tmpVault);

    expect(stats2.notesMissingEmbeddings).toBe(0);
    expect(getSyncMtime(db, 'recover-note.md')).toBeDefined();
  });

  it('F6: happy path — no missing notes → notesMissingEmbeddings === 0', async () => {
    writeNote(tmpVault, 'happy-note.md', makeMultiSectionNote(2));

    const embedder = new InstantMockEmbedder();
    const pipeline = new IndexPipeline(db, embedder);
    const stats = await pipeline.index(tmpVault);

    expect(stats.notesMissingEmbeddings).toBe(0);
  });

  // -------------------------------------------------------------------------
  // F4 — Top-level SQL error classifier
  // -------------------------------------------------------------------------

  it('F4: SQL bind error from DB op re-thrown with actionable wrapper message', async () => {
    writeNote(tmpVault, 'sql-err-note.md', makeMultiSectionNote(1));

    const embedder = new InstantMockEmbedder();
    const pipeline = new IndexPipeline(db, embedder);

    // Inject a SQL bind error into the DB at a point that escapes all inner
    // guards — spy on db.prepare so that setSyncMtime's statement throws.
    // We target the SQL that setSyncMtime runs (INSERT INTO sync).
    const origPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.includes('INSERT INTO sync')) {
        // Replace run() on this statement to throw the SQLite bind error.
        (stmt as typeof stmt & { run: (...args: unknown[]) => unknown }).run = (...args: unknown[]) => {
          throw new RangeError('Too few parameter values were provided');
        };
      }
      return stmt;
    });

    await expect(pipeline.index(tmpVault)).rejects.toThrow(
      /likely schema drift or stale install/,
    );

    vi.restoreAllMocks();
  });

  it('F4: non-SQL unguarded errors bubble up unchanged', async () => {
    writeNote(tmpVault, 'random-err-note.md', makeMultiSectionNote(1));

    const embedder = new InstantMockEmbedder();
    const pipeline = new IndexPipeline(db, embedder);

    const origPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.includes('INSERT INTO sync')) {
        (stmt as typeof stmt & { run: (...args: unknown[]) => unknown }).run = (...args: unknown[]) => {
          throw new Error('some completely unrelated runtime error');
        };
      }
      return stmt;
    });

    // Should NOT wrap — re-throws unchanged.
    await expect(pipeline.index(tmpVault)).rejects.toThrow(
      'some completely unrelated runtime error',
    );

    vi.restoreAllMocks();
  });

  it('F4: SQL error writes schema drift guidance to stderr', async () => {
    writeNote(tmpVault, 'sql-stderr-note.md', makeMultiSectionNote(1));

    const embedder = new InstantMockEmbedder();
    const pipeline = new IndexPipeline(db, embedder);

    const origPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      const stmt = origPrepare(sql);
      if (sql.includes('INSERT INTO sync')) {
        (stmt as typeof stmt & { run: (...args: unknown[]) => unknown }).run = (...args: unknown[]) => {
          throw new RangeError('Too few parameter values were provided');
        };
      }
      return stmt;
    });

    const stderrLines: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrLines.push(String(chunk));
        return true;
      });

    try {
      await pipeline.index(tmpVault).catch(() => {/* expected */});
    } finally {
      stderrSpy.mockRestore();
      vi.restoreAllMocks();
    }

    const guidanceLine = stderrLines.find((l) => l.includes('schema drift') && l.includes('rm -rf'));
    expect(guidanceLine).toBeDefined();
  });
});
