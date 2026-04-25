import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { bootstrap } from '../../src/pipeline/bootstrap.js';
import {
  getCapacity,
  recordFailedChunk,
  reduceDiscoveredMaxTokens,
} from '../../src/embeddings/capacity.js';
import type { Embedder } from '../../src/embeddings/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class StubEmbedder implements Embedder {
  constructor(
    private readonly _model: string,
    private readonly _dim: number = 384,
    private readonly _provider: string = 'stub',
  ) {}
  async init(): Promise<void> {}
  async embed(): Promise<Float32Array> { return new Float32Array(this._dim); }
  dimensions(): number { return this._dim; }
  modelIdentifier(): string { return this._model; }
  providerName(): string { return this._provider; }
  async dispose(): Promise<void> {}
}

/**
 * Minimal TransformersEmbedder-like stub that exposes the `extractor` field
 * the capacity module reads to get model_max_length.
 */
class TransformersStub extends StubEmbedder {
  // Expose extractor the same way TransformersEmbedder does.
  readonly extractor: { tokenizer: { model_max_length: number } } | null;

  constructor(modelId: string, modelMaxLength: number | null) {
    super(modelId, 384, 'transformers.js');
    this.extractor =
      modelMaxLength !== null ? { tokenizer: { model_max_length: modelMaxLength } } : null;
  }
}

/**
 * Minimal OllamaEmbedder-like stub with a controllable baseUrl.
 */
class OllamaStub extends StubEmbedder {
  readonly baseUrl: string;
  constructor(modelId: string, ollamaBaseUrl: string) {
    // modelIdentifier() for Ollama returns "ollama:<model>"
    super(`ollama:${modelId}`, 768, 'ollama');
    this.baseUrl = ollamaBaseUrl;
  }
}

function openTestDb(): DatabaseHandle {
  const db = openDb(':memory:');
  bootstrap(db, new StubEmbedder('test/model', 384, 'stub'));
  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getCapacity — transformers.js path', () => {
  let db: DatabaseHandle;

  beforeEach(() => { db = openTestDb(); });
  afterEach(() => { db.close(); });

  it('reads model_max_length from tokenizer config and returns correct budget', async () => {
    const emb = new TransformersStub('Xenova/bge-large-en-v1.5', 8192);
    const cap = await getCapacity(db, emb);
    expect(cap.advertisedMaxTokens).toBe(8192);
    expect(cap.discoveredMaxTokens).toBe(8192);
    expect(cap.method).toBe('tokenizer_config');
    // chunkBudgetTokens = floor(0.9 * 8192) = 7372
    expect(cap.chunkBudgetTokens).toBe(7372);
    // chunkBudgetChars = floor(7372 * 2.5) = 18430
    expect(cap.chunkBudgetChars).toBe(18430);
  });

  it('overrides stale 512 config with validation table value for known model', async () => {
    // Xenova/nomic-embed-text-v1 tokenizer config reports 512 but is actually 8192
    const emb = new TransformersStub('Xenova/nomic-embed-text-v1', 512);
    const cap = await getCapacity(db, emb);
    expect(cap.advertisedMaxTokens).toBe(8192);
    expect(cap.chunkBudgetTokens).toBe(7372);
    expect(cap.method).toBe('tokenizer_config');
  });

  it('uses tokenizer config value when it is correct (non-stale 512)', async () => {
    // Xenova/multilingual-e5-small is in KNOWN_MAX_TOKENS as 512 — should stay at 512.
    const emb = new TransformersStub('Xenova/multilingual-e5-small', 512);
    const cap = await getCapacity(db, emb);
    expect(cap.advertisedMaxTokens).toBe(512);
    expect(cap.chunkBudgetTokens).toBe(460); // floor(0.9 * 512)
  });

  it('falls back to manual (validation table) when tokenizer returns null', async () => {
    const emb = new TransformersStub('Xenova/bge-m3', null);
    const cap = await getCapacity(db, emb);
    expect(cap.advertisedMaxTokens).toBe(8192);
    expect(cap.method).toBe('manual');
  });

  it('falls back to fallback (512) for unknown model with no tokenizer', async () => {
    const emb = new TransformersStub('custom/unknown-model', null);
    const cap = await getCapacity(db, emb);
    expect(cap.advertisedMaxTokens).toBe(512);
    expect(cap.method).toBe('fallback');
  });
});

describe('getCapacity — Ollama path', () => {
  let db: DatabaseHandle;

  beforeEach(() => { db = openTestDb(); });
  afterEach(() => { db.close(); });

  it('reads context_length from model_info via /api/show and returns correct budget', async () => {
    // Use a local HTTP server mock via global fetch spy.
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_info: { 'llama.context_length': 8192 },
      }),
    } as Response);

    const emb = new OllamaStub('llama3-embed', 'http://localhost:11434');
    const cap = await getCapacity(db, emb);

    expect(cap.advertisedMaxTokens).toBe(8192);
    expect(cap.discoveredMaxTokens).toBe(8192);
    expect(cap.method).toBe('api_show');
    expect(cap.chunkBudgetTokens).toBe(7372);

    mockFetch.mockRestore();
  });

  it('reads context_length from model_info key ending in .context_length', async () => {
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_info: { 'nomic.context_length': 8192, 'other.field': 'ignored' },
      }),
    } as Response);

    const emb = new OllamaStub('nomic-embed-text', 'http://localhost:11434');
    const cap = await getCapacity(db, emb);
    expect(cap.advertisedMaxTokens).toBe(8192);
    expect(cap.method).toBe('api_show');

    mockFetch.mockRestore();
  });

  it('falls back to num_ctx in parameters string when model_info is absent', async () => {
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        model_info: {},
        parameters: 'num_ctx 4096\nstop "<|eot_id|>"',
      }),
    } as Response);

    const emb = new OllamaStub('custom-embed', 'http://localhost:11434');
    const cap = await getCapacity(db, emb);
    expect(cap.advertisedMaxTokens).toBe(4096);
    expect(cap.method).toBe('api_show');

    mockFetch.mockRestore();
  });

  it('falls back to 512 when /api/show fails', async () => {
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: false,
      status: 404,
    } as Response);

    const emb = new OllamaStub('missing-model', 'http://localhost:11434');
    const cap = await getCapacity(db, emb);
    expect(cap.advertisedMaxTokens).toBe(512);
    expect(cap.method).toBe('fallback');

    mockFetch.mockRestore();
  });
});

describe('getCapacity — cache miss → probe → insert → hit', () => {
  let db: DatabaseHandle;

  beforeEach(() => { db = openTestDb(); });
  afterEach(() => { db.close(); });

  it('caches the probe result and returns the same value on second call without hitting fetch', async () => {
    let fetchCallCount = 0;
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      fetchCallCount++;
      return {
        ok: true,
        json: async () => ({ model_info: { 'llama.context_length': 4096 } }),
      } as Response;
    });

    const emb = new OllamaStub('cached-model', 'http://localhost:11434');

    // First call → cache miss → probe (one fetch).
    const first = await getCapacity(db, emb);
    expect(first.advertisedMaxTokens).toBe(4096);
    expect(fetchCallCount).toBe(1);

    // Second call → cache hit → no fetch.
    const second = await getCapacity(db, emb);
    expect(second.advertisedMaxTokens).toBe(4096);
    expect(fetchCallCount).toBe(1); // still 1

    mockFetch.mockRestore();
  });

  it('second call with transformers embedder uses cache without re-reading extractor', async () => {
    const emb = new TransformersStub('Xenova/bge-large-en-v1.5', 8192);

    const first = await getCapacity(db, emb);
    const second = await getCapacity(db, emb);

    expect(first.advertisedMaxTokens).toBe(8192);
    expect(second.advertisedMaxTokens).toBe(8192);
    expect(second.method).toBe('tokenizer_config');
  });
});

describe('getCapacity — OBSIDIAN_BRAIN_MAX_CHUNK_TOKENS env override', () => {
  let db: DatabaseHandle;
  const OLD_ENV = process.env;

  beforeEach(() => {
    db = openTestDb();
    process.env = { ...OLD_ENV };
  });

  afterEach(() => {
    db.close();
    process.env = OLD_ENV;
  });

  it('env override beats tokenizer config', async () => {
    process.env.OBSIDIAN_BRAIN_MAX_CHUNK_TOKENS = '2000';
    const emb = new TransformersStub('Xenova/bge-large-en-v1.5', 8192);
    const cap = await getCapacity(db, emb);
    expect(cap.advertisedMaxTokens).toBe(2000);
    expect(cap.discoveredMaxTokens).toBe(2000);
    expect(cap.method).toBe('manual');
    expect(cap.chunkBudgetTokens).toBe(1800); // floor(0.9 * 2000)
  });

  it('env override beats Ollama /api/show', async () => {
    process.env.OBSIDIAN_BRAIN_MAX_CHUNK_TOKENS = '1024';
    const mockFetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({ model_info: { 'llama.context_length': 8192 } }),
    } as Response);

    const emb = new OllamaStub('big-model', 'http://localhost:11434');
    const cap = await getCapacity(db, emb);
    expect(cap.advertisedMaxTokens).toBe(1024);
    expect(cap.method).toBe('manual');

    // fetch should NOT have been called (env override short-circuits probe).
    expect(mockFetch).not.toHaveBeenCalled();
    mockFetch.mockRestore();
  });
});

describe('recordFailedChunk', () => {
  let db: DatabaseHandle;

  beforeEach(() => { db = openTestDb(); });
  afterEach(() => { db.close(); });

  it('inserts a failed chunk row', () => {
    recordFailedChunk(db, 'note.md::0', 'note.md', 'too_large', 'Token limit exceeded');
    const row = db.prepare(
      "SELECT chunk_id, note_id, reason, error_message FROM failed_chunks WHERE chunk_id = 'note.md::0'",
    ).get() as { chunk_id: string; note_id: string; reason: string; error_message: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.note_id).toBe('note.md');
    expect(row!.reason).toBe('too_large');
    expect(row!.error_message).toBe('Token limit exceeded');
  });

  it('upserts on duplicate chunk_id (updates reason + error_message)', () => {
    recordFailedChunk(db, 'note.md::0', 'note.md', 'too_large', 'first error');
    recordFailedChunk(db, 'note.md::0', 'note.md', 'embed_error', 'second error');
    const count = (db.prepare(
      "SELECT COUNT(*) AS n FROM failed_chunks WHERE chunk_id = 'note.md::0'",
    ).get() as { n: number }).n;
    expect(count).toBe(1);
    const row = db.prepare(
      "SELECT reason FROM failed_chunks WHERE chunk_id = 'note.md::0'",
    ).get() as { reason: string };
    expect(row.reason).toBe('embed_error');
  });
});

describe('reduceDiscoveredMaxTokens', () => {
  let db: DatabaseHandle;

  beforeEach(() => { db = openTestDb(); });
  afterEach(() => { db.close(); });

  it('sets discovered_max_tokens to half of the failing chunk token count', async () => {
    const emb = new TransformersStub('Xenova/bge-large-en-v1.5', 8192);
    // Seed an initial capacity entry.
    await getCapacity(db, emb);
    // Now reduce: chunk of 600 tokens failed → new ceiling is 300.
    reduceDiscoveredMaxTokens(db, emb, 600);
    const row = db.prepare(
      'SELECT discovered_max_tokens FROM embedder_capability WHERE embedder_id = ?',
    ).get(emb.modelIdentifier()) as { discovered_max_tokens: number };
    expect(row.discovered_max_tokens).toBe(300);
  });

  it('is a one-way ratchet — does not increase an already-lower discovered bound', async () => {
    const emb = new TransformersStub('Xenova/bge-large-en-v1.5', 8192);
    await getCapacity(db, emb);
    // v1.7.3: half of 200 is 100, but the MIN_DISCOVERED_TOKENS=256 floor
    // applies (advertised is 8192 so floor is the full 256). So this sets
    // discovered to 256.
    reduceDiscoveredMaxTokens(db, emb, 200);
    // 1000/2 = 500. Existing is 256, MIN(256, 500) = 256 (one-way ratchet).
    reduceDiscoveredMaxTokens(db, emb, 1000);
    const row = db.prepare(
      'SELECT discovered_max_tokens FROM embedder_capability WHERE embedder_id = ?',
    ).get(emb.modelIdentifier()) as { discovered_max_tokens: number };
    expect(row.discovered_max_tokens).toBe(256);
  });

  it('v1.7.3: floor is min(MIN_DISCOVERED_TOKENS=256, advertised) — never below 256 for normal models', async () => {
    const emb = new TransformersStub('Xenova/bge-large-en-v1.5', 8192);
    await getCapacity(db, emb);
    // half of 100 = 50; floor=min(256, 8192)=256; max(256, 50)=256.
    reduceDiscoveredMaxTokens(db, emb, 100);
    const row = db.prepare(
      'SELECT discovered_max_tokens FROM embedder_capability WHERE embedder_id = ?',
    ).get(emb.modelIdentifier()) as { discovered_max_tokens: number };
    expect(row.discovered_max_tokens).toBe(256);
  });

  it('v1.7.3: tiny-model floor is the model\'s advertised limit, not the global 256', async () => {
    const emb = new TransformersStub('test/model', 128);
    await getCapacity(db, emb);
    // half of 1 = 0; floor=min(256, 128)=128; max(128, 0)=128.
    reduceDiscoveredMaxTokens(db, emb, 1);
    const row = db.prepare(
      'SELECT discovered_max_tokens FROM embedder_capability WHERE embedder_id = ?',
    ).get(emb.modelIdentifier()) as { discovered_max_tokens: number };
    expect(row.discovered_max_tokens).toBe(128);
  });

  it('works even when no prior cache entry exists (inserts fresh row)', () => {
    const emb = new TransformersStub('Xenova/bge-small-en-v1.5', 512);
    // No getCapacity call first — fresh insert. v1.7.3: with no cached row,
    // advertised falls back to FALLBACK_MAX_TOKENS=512 → floor=256 →
    // max(256, 200) = 256.
    expect(() => reduceDiscoveredMaxTokens(db, emb, 400)).not.toThrow();
    const row = db.prepare(
      'SELECT discovered_max_tokens FROM embedder_capability WHERE embedder_id = ?',
    ).get(emb.modelIdentifier()) as { discovered_max_tokens: number } | undefined;
    expect(row?.discovered_max_tokens).toBe(256);
  });
});
