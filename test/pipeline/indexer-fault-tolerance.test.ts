/**
 * Fault-tolerance tests for IndexPipeline.embedChunks.
 *
 * These tests use lightweight mock embedders (no real model loaded) and a
 * temporary vault so they run quickly in CI without the 2-min model init.
 *
 * Scenarios covered:
 *  1. Happy path — all embeds succeed → chunksSkipped === 0.
 *  2. One chunk throws "input length exceeds" → loop continues, chunksSkipped === 1.
 *  3. Dead-embedder error (ECONNREFUSED) → re-thrown out of index().
 *  4. Stderr summary line is emitted when chunksSkipped > 0.
 *  5. Per-chunk skip log line format is correct.
 *  6. Unknown error is treated as skip.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { bootstrap } from '../../src/pipeline/bootstrap.js';
import { IndexPipeline } from '../../src/pipeline/indexer.js';
import type { Embedder } from '../../src/embeddings/types.js';
import { InstantMockEmbedder } from '../helpers/mock-embedders.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Enough filler text to exceed the chunker's minChunkChars (50) so we get
// real chunks out of the chunker. Each section is ~80 chars.
const SECTION_FILLER = 'This section has enough content to pass the minimum chunk character threshold.';

/**
 * Wraps InstantMockEmbedder to throw on a specific embed call index.
 * The index counts across ALL embed() calls (chunks + note-level).
 */
class FaultyOnCallEmbedder extends InstantMockEmbedder {
  private callCount = 0;

  constructor(
    private readonly failOnCallIndex: number,
    private readonly failureMessage: string,
  ) {
    super();
  }

  override async embed(text: string, taskType?: 'document' | 'query'): Promise<Float32Array> {
    const idx = this.callCount++;
    if (idx === this.failOnCallIndex) {
      throw new Error(this.failureMessage);
    }
    return super.embed(text, taskType);
  }
}

/**
 * Embedder that always throws every time embed() is called.
 */
class AlwaysFailEmbedder extends InstantMockEmbedder {
  constructor(private readonly failureMessage: string) {
    super();
  }

  override async embed(_text: string, _taskType?: 'document' | 'query'): Promise<Float32Array> {
    throw new Error(this.failureMessage);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeTmpVault(): string {
  return mkdtempSync(join(tmpdir(), 'obs-brain-faulttol-'));
}

function writeNote(vaultPath: string, name: string, content: string): void {
  writeFileSync(join(vaultPath, name), content, 'utf8');
}

/** Build a note with N sections, each long enough to form a chunk. */
function makeMultiSectionNote(numSections: number): string {
  return Array.from({ length: numSections }, (_, i) =>
    `# Section ${i + 1}\n\n${SECTION_FILLER}\n`,
  ).join('\n');
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IndexPipeline — fault tolerance (per-chunk embed)', () => {
  let db: DatabaseHandle;
  let tmpVault: string;

  beforeEach(() => {
    db = openDb(':memory:');
    // Bootstrap runs schema migrations including createEmbedderCapabilityTable
    // and createFailedChunksTable — required now that IndexPipeline calls
    // getCapacity() and recordFailedChunk() on first use.
    bootstrap(db, new InstantMockEmbedder());
    tmpVault = makeTmpVault();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpVault, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('happy path: all chunks succeed → chunksSkipped === 0', async () => {
    writeNote(tmpVault, 'note.md', makeMultiSectionNote(2));

    const embedder: Embedder = new InstantMockEmbedder();
    const pipeline = new IndexPipeline(db, embedder);
    const stats = await pipeline.index(tmpVault);

    expect(stats.chunksSkipped).toBe(0);
    expect(stats.chunksOk).toBeGreaterThan(0);
    expect(stats.nodesIndexed).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // "Too long" error families — all should skip, not throw
  // -------------------------------------------------------------------------

  it('one chunk throws "input length exceeds" → skipped, others succeed', async () => {
    // Two-section note → two chunks. Call 0 is the first chunk embed.
    // Call 1 is the second chunk embed. Call 2 is the note-level embed.
    writeNote(tmpVault, 'big-note.md', makeMultiSectionNote(2));

    const embedder = new FaultyOnCallEmbedder(0, 'input length exceeds the context length of 512');
    const pipeline = new IndexPipeline(db, embedder);
    const stats = await pipeline.index(tmpVault);

    expect(stats.chunksSkipped).toBe(1);
    expect(stats.nodesIndexed).toBe(1); // the note itself still indexed
  });

  it('one chunk throws "maximum context length" → skipped', async () => {
    writeNote(tmpVault, 'ctx-note.md', makeMultiSectionNote(2));

    const embedder = new FaultyOnCallEmbedder(0, 'This exceeds the maximum context length for this model');
    const pipeline = new IndexPipeline(db, embedder);
    const stats = await pipeline.index(tmpVault);

    expect(stats.chunksSkipped).toBe(1);
    expect(stats.nodesIndexed).toBe(1);
  });

  it('one chunk throws ONNX "Cannot broadcast" → skipped', async () => {
    writeNote(tmpVault, 'onnx-note.md', makeMultiSectionNote(1));

    const embedder = new FaultyOnCallEmbedder(0, 'Cannot broadcast [1, 512] to [1, 256]');
    const pipeline = new IndexPipeline(db, embedder);
    const stats = await pipeline.index(tmpVault);

    expect(stats.chunksSkipped).toBe(1);
    expect(stats.nodesIndexed).toBe(1);
  });

  it('one chunk throws "too many tokens" → skipped', async () => {
    writeNote(tmpVault, 'tokens-note.md', makeMultiSectionNote(1));

    const embedder = new FaultyOnCallEmbedder(0, 'too many tokens in the sequence (1024 > 512)');
    const pipeline = new IndexPipeline(db, embedder);
    const stats = await pipeline.index(tmpVault);

    expect(stats.chunksSkipped).toBe(1);
    expect(stats.nodesIndexed).toBe(1);
  });

  it('one chunk throws "input_too_long" → skipped', async () => {
    writeNote(tmpVault, 'itl-note.md', makeMultiSectionNote(1));

    const embedder = new FaultyOnCallEmbedder(0, 'input_too_long: sequence exceeds max length');
    const pipeline = new IndexPipeline(db, embedder);
    const stats = await pipeline.index(tmpVault);

    expect(stats.chunksSkipped).toBe(1);
    expect(stats.nodesIndexed).toBe(1);
  });

  it('one chunk throws "shape mismatch" → skipped', async () => {
    writeNote(tmpVault, 'shape-note.md', makeMultiSectionNote(1));

    const embedder = new FaultyOnCallEmbedder(0, 'shape mismatch: expected [1, 384] got [1, 512]');
    const pipeline = new IndexPipeline(db, embedder);
    const stats = await pipeline.index(tmpVault);

    expect(stats.chunksSkipped).toBe(1);
    expect(stats.nodesIndexed).toBe(1);
  });

  it('one chunk throws "context length" → skipped', async () => {
    writeNote(tmpVault, 'cl-note.md', makeMultiSectionNote(1));

    const embedder = new FaultyOnCallEmbedder(0, 'context length exceeded');
    const pipeline = new IndexPipeline(db, embedder);
    const stats = await pipeline.index(tmpVault);

    expect(stats.chunksSkipped).toBe(1);
    expect(stats.nodesIndexed).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Regression: ONNX "neural network" must NOT be treated as dead-embedder
  // -------------------------------------------------------------------------

  it('ONNX "neural network input tensor shape mismatch" → skipped (not dead)', async () => {
    // The old /network/i regex would have matched "neural network" and re-thrown,
    // aborting the whole reindex. The narrowed pattern must classify this as
    // too-long (skip) instead.
    writeNote(tmpVault, 'onnx-shape-note.md', makeMultiSectionNote(1));

    const embedder = new FaultyOnCallEmbedder(
      0,
      'ONNX Runtime: neural network input tensor shape mismatch: expected [1,512] got [1,768]',
    );
    const pipeline = new IndexPipeline(db, embedder);
    const stats = await pipeline.index(tmpVault);

    expect(stats.chunksSkipped).toBe(1);
    expect(stats.nodesIndexed).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Dead-embedder — should re-throw
  // -------------------------------------------------------------------------

  it('dead embedder (ECONNREFUSED) → re-throws out of index()', async () => {
    writeNote(tmpVault, 'dead-note.md', makeMultiSectionNote(1));

    const embedder = new AlwaysFailEmbedder('connect ECONNREFUSED 127.0.0.1:11434');
    const pipeline = new IndexPipeline(db, embedder);

    await expect(pipeline.index(tmpVault)).rejects.toThrow('ECONNREFUSED');
  });

  it('dead embedder (ENOTFOUND) → re-throws', async () => {
    writeNote(tmpVault, 'notfound-note.md', makeMultiSectionNote(1));

    const embedder = new AlwaysFailEmbedder('getaddrinfo ENOTFOUND ollama.local');
    const pipeline = new IndexPipeline(db, embedder);

    await expect(pipeline.index(tmpVault)).rejects.toThrow('ENOTFOUND');
  });

  // -------------------------------------------------------------------------
  // Unknown errors — treated as skip
  // -------------------------------------------------------------------------

  it('unknown error → treated as skip (better than halt)', async () => {
    writeNote(tmpVault, 'unknown-note.md', makeMultiSectionNote(1));

    const embedder = new FaultyOnCallEmbedder(0, 'some totally unexpected embedder error XYZ');
    const pipeline = new IndexPipeline(db, embedder);
    const stats = await pipeline.index(tmpVault);

    // Should not throw; unknown errors are skipped
    expect(stats.chunksSkipped).toBe(1);
    expect(stats.nodesIndexed).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Stderr output
  // -------------------------------------------------------------------------

  it('emits stderr summary line when chunksSkipped > 0', async () => {
    writeNote(tmpVault, 'stderr-note.md', makeMultiSectionNote(1));

    const stderrLines: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrLines.push(String(chunk));
        return true;
      });

    try {
      const embedder = new FaultyOnCallEmbedder(0, 'input length exceeds the context length');
      const pipeline = new IndexPipeline(db, embedder);
      await pipeline.index(tmpVault);
    } finally {
      stderrSpy.mockRestore();
    }

    const summaryLine = stderrLines.find((l) =>
      l.includes('chunks ok') && l.includes('chunks skipped'),
    );
    expect(summaryLine).toBeDefined();
    expect(summaryLine).toMatch(/obsidian-brain: indexed \d+ notes \(\d+ chunks ok, \d+ chunks skipped\)\./);
  });

  it('does NOT emit stderr summary on the happy path (chunksSkipped === 0)', async () => {
    writeNote(tmpVault, 'quiet-note.md', makeMultiSectionNote(1));

    const stderrLines: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrLines.push(String(chunk));
        return true;
      });

    try {
      const embedder = new InstantMockEmbedder();
      const pipeline = new IndexPipeline(db, embedder);
      await pipeline.index(tmpVault);
    } finally {
      stderrSpy.mockRestore();
    }

    const summaryLine = stderrLines.find((l) =>
      l.includes('chunks ok') && l.includes('chunks skipped'),
    );
    expect(summaryLine).toBeUndefined();
  });

  it('emits per-chunk skip log line with correct node/chunk/chars fields', async () => {
    writeNote(tmpVault, 'skip-line-note.md', makeMultiSectionNote(1));

    const stderrLines: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrLines.push(String(chunk));
        return true;
      });

    try {
      const embedder = new FaultyOnCallEmbedder(0, 'input length exceeds the context length');
      const pipeline = new IndexPipeline(db, embedder);
      await pipeline.index(tmpVault);
    } finally {
      stderrSpy.mockRestore();
    }

    const skipLine = stderrLines.find((l) =>
      l.includes('chunk too large for embedder') && l.includes('skipping'),
    );
    expect(skipLine).toBeDefined();
    expect(skipLine).toMatch(/node: skip-line-note\.md/);
    expect(skipLine).toMatch(/chunk: \d+/);
    expect(skipLine).toMatch(/chars: \d+/);
  });

  it('emits unrecognised-error skip log for unknown errors', async () => {
    writeNote(tmpVault, 'unrec-note.md', makeMultiSectionNote(1));

    const stderrLines: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrLines.push(String(chunk));
        return true;
      });

    try {
      const embedder = new FaultyOnCallEmbedder(0, 'some totally unexpected embedder error XYZ');
      const pipeline = new IndexPipeline(db, embedder);
      await pipeline.index(tmpVault);
    } finally {
      stderrSpy.mockRestore();
    }

    const warnLine = stderrLines.find((l) =>
      l.includes('unrecognised error') && l.includes('skipping'),
    );
    expect(warnLine).toBeDefined();
  });
});
