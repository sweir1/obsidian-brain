/**
 * Unit tests for src/cli/models.ts (v1.7.5+).
 *
 * Strategy: import `registerModelsCommands`, attach it to a Commander
 * program, and invoke actions directly by calling
 * `program.parseAsync(['node', 'cli', 'models', ...args])`. Capture
 * stdout/stderr by replacing `process.stdout.write` and
 * `process.stderr.write` with spies. Mock heavy dependencies
 * (prefetchModel, autoRecommendPreset, getEmbeddingMetadata) so no real
 * network calls are made.
 *
 * v1.7.5 changes: `models check <id>` now calls `getEmbeddingMetadata`
 * (HF API only, no model download) by default. The old prefetch behaviour
 * is opt-in via `--load`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

const { mockPrefetchModel, mockAutoRecommendPreset, mockGetEmbeddingMetadata } = vi.hoisted(() => ({
  mockPrefetchModel: vi.fn(),
  mockAutoRecommendPreset: vi.fn(),
  mockGetEmbeddingMetadata: vi.fn(),
}));

vi.mock('../../src/embeddings/prefetch.js', () => ({
  prefetchModel: mockPrefetchModel,
}));

vi.mock('../../src/embeddings/auto-recommend.js', () => ({
  autoRecommendPreset: mockAutoRecommendPreset,
}));

vi.mock('../../src/embeddings/hf-metadata.js', () => ({
  getEmbeddingMetadata: mockGetEmbeddingMetadata,
  DEFAULT_HF_TIMEOUT_MS: 5000,
  DEFAULT_HF_RETRIES: 2,
}));

import { registerModelsCommands } from '../../src/cli/models.js';
import { EMBEDDING_PRESETS } from '../../src/embeddings/presets.js';

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

interface CapturedOutput {
  stdout: string;
  stderr: string;
}

async function runModels(args: string[]): Promise<CapturedOutput> {
  const program = new Command();
  program
    .name('obsidian-brain')
    .exitOverride()
    .configureOutput({
      writeErr: () => {},
    });

  registerModelsCommands(program);

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);

  (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (chunk) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (chunk) => {
    stderrChunks.push(String(chunk));
    return true;
  };

  try {
    await program.parseAsync(['node', 'cli', 'models', ...args]);
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }

  return { stdout: stdoutChunks.join(''), stderr: stderrChunks.join('') };
}

// ---------------------------------------------------------------------------
// models list
// ---------------------------------------------------------------------------

describe('models list', () => {
  it('prints valid JSON to stdout containing every preset key', async () => {
    const { stdout } = await runModels(['list']);
    const parsed = JSON.parse(stdout) as Array<{ preset: string }>;
    const outputKeys = parsed.map((e) => e.preset);
    for (const key of Object.keys(EMBEDDING_PRESETS)) {
      expect(outputKeys).toContain(key);
    }
  });

  it('JSON output has expected v1.7.5 fields per entry', async () => {
    const { stdout } = await runModels(['list']);
    const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
    expect(parsed.length).toBeGreaterThan(0);
    for (const entry of parsed) {
      expect(entry).toHaveProperty('preset');
      expect(entry).toHaveProperty('model');
      expect(entry).toHaveProperty('provider');
      // v1.7.5 schema v2 seed carries only load-bearing fields. `dim` is
      // probed at runtime from ONNX (not in seed); `sizeMb` only via live
      // HF probe (`models check <id>`). What stays in `models list` is
      // maxTokens (advertised) + symmetric (computed from prefixes).
      expect(entry).toHaveProperty('maxTokens');
      expect(entry).toHaveProperty('symmetric');
    }
  });

  it('stdout is always valid JSON regardless of TTY state (non-TTY)', async () => {
    const { stdout, stderr } = await runModels(['list']);
    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).not.toContain('Embedding presets:');
  });

  it('stderr table is written when stdout is a TTY', async () => {
    const origIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });

    const { stdout, stderr } = await runModels(['list']);

    Object.defineProperty(process.stdout, 'isTTY', { value: origIsTTY, configurable: true });

    expect(() => JSON.parse(stdout)).not.toThrow();
    expect(stderr).toContain('Embedding presets:');
    expect(stderr).toContain('english');
  });
});

// ---------------------------------------------------------------------------
// models recommend
// ---------------------------------------------------------------------------

describe('models recommend', () => {
  const origVaultPath = process.env.VAULT_PATH;

  afterEach(() => {
    if (origVaultPath === undefined) {
      delete process.env.VAULT_PATH;
    } else {
      process.env.VAULT_PATH = origVaultPath;
    }
    mockAutoRecommendPreset.mockReset();
  });

  it('calls autoRecommendPreset with env, VAULT_PATH, undefined and prints JSON', async () => {
    process.env.VAULT_PATH = '/test/vault';
    mockAutoRecommendPreset.mockResolvedValue({
      preset: 'english',
      reason: 'no non-Latin characters detected',
      skipped: false,
    });

    const { stdout } = await runModels(['recommend']);

    expect(mockAutoRecommendPreset).toHaveBeenCalledWith(
      process.env,
      '/test/vault',
      undefined,
    );
    const parsed = JSON.parse(stdout);
    expect(parsed.preset).toBe('english');
    expect(parsed.model).toBe('Xenova/bge-small-en-v1.5');
    expect(parsed.reason).toBeTruthy();
  });

  it('renders skipped result with skipped=true when model already set', async () => {
    process.env.VAULT_PATH = '/test/vault';
    mockAutoRecommendPreset.mockResolvedValue({
      preset: 'english',
      reason: 'explicit env var set',
      skipped: true,
    });

    const { stdout } = await runModels(['recommend']);
    const parsed = JSON.parse(stdout);
    expect(parsed.skipped).toBe(true);
    expect(parsed.preset).toBe('english');
  });

  it('exits with error when VAULT_PATH is not set', async () => {
    delete process.env.VAULT_PATH;
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    await runModels(['recommend']).catch(() => {});

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// models prefetch
// ---------------------------------------------------------------------------

describe('models prefetch', () => {
  beforeEach(() => {
    mockPrefetchModel.mockReset();
    mockPrefetchModel.mockResolvedValue({
      model: 'Xenova/bge-small-en-v1.5',
      dim: 384,
      attempts: 1,
      cachedAt: '2026-04-23T00:00:00.000Z',
    });
  });

  it('defaults to english preset — calls prefetchModel with bge-small-en-v1.5', async () => {
    await runModels(['prefetch']);
    expect(mockPrefetchModel).toHaveBeenCalledWith(
      'Xenova/bge-small-en-v1.5',
      expect.objectContaining({ backoffBaseMs: 1000 }),
    );
  });

  it('prints JSON with model, dim, cachedAt, durationMs', async () => {
    const { stdout } = await runModels(['prefetch']);
    const parsed = JSON.parse(stdout);
    expect(parsed).toHaveProperty('model');
    expect(parsed).toHaveProperty('dim');
    expect(parsed).toHaveProperty('cachedAt');
    expect(parsed).toHaveProperty('durationMs');
    expect(typeof parsed.durationMs).toBe('number');
  });

  it('exits with error for unknown preset', async () => {
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    await runModels(['prefetch', 'nonexistent-preset']).catch(() => {});
    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// models check (v1.7.5: metadata-only by default; --load to also download)
// ---------------------------------------------------------------------------

describe('models check', () => {
  beforeEach(() => {
    mockPrefetchModel.mockReset();
    mockGetEmbeddingMetadata.mockReset();
    mockGetEmbeddingMetadata.mockResolvedValue({
      modelId: 'Xenova/bge-small-en-v1.5',
      modelType: 'bert',
      hiddenSize: 384,
      numLayers: 6,
      dim: 384,
      hasDenseLayer: false,
      hasNormalize: true,
      maxTokens: 512,
      queryPrefix: 'Represent this sentence for searching relevant passages: ',
      documentPrefix: '',
      prefixSource: 'metadata',
      baseModel: null,
      sizeBytes: 35200000,
      sources: {
        hadModulesJson: true,
        hadSentenceBertConfig: true,
        hadSentenceTransformersConfig: true,
        hadOnnxDir: true,
        maxTokensFrom: 'sentence_bert_config',
      },
    });
  });

  it('calls getEmbeddingMetadata with the provided id (no model download)', async () => {
    await runModels(['check', 'Xenova/bge-small-en-v1.5']);
    expect(mockGetEmbeddingMetadata).toHaveBeenCalledWith(
      'Xenova/bge-small-en-v1.5',
      expect.objectContaining({ timeoutMs: expect.any(Number) }),
    );
    // Critically: NO prefetchModel call by default.
    expect(mockPrefetchModel).not.toHaveBeenCalled();
  });

  it('output JSON has dim, symmetric, queryPrefix, prefixSource, ready', async () => {
    const { stdout } = await runModels(['check', 'Xenova/bge-small-en-v1.5']);
    const parsed = JSON.parse(stdout);

    expect(parsed.model).toBe('Xenova/bge-small-en-v1.5');
    expect(parsed.dim).toBe(384);
    expect(typeof parsed.symmetric).toBe('boolean');
    expect(typeof parsed.queryPrefix).toBe('string');
    expect(parsed.prefixSource).toBe('metadata');
    expect(parsed.ready).toBe(true);
  });

  it('bge model derives symmetric=false from differing prefixes', async () => {
    const { stdout } = await runModels(['check', 'Xenova/bge-small-en-v1.5']);
    const parsed = JSON.parse(stdout);
    expect(parsed.symmetric).toBe(false);
  });

  it('symmetric model (matching empty prefixes) reports symmetric=true', async () => {
    mockGetEmbeddingMetadata.mockResolvedValue({
      modelId: 'Xenova/all-MiniLM-L6-v2',
      modelType: 'bert',
      hiddenSize: 384,
      numLayers: 6,
      dim: 384,
      hasDenseLayer: false,
      hasNormalize: true,
      maxTokens: 512,
      queryPrefix: '',
      documentPrefix: '',
      prefixSource: 'none',
      baseModel: null,
      sizeBytes: 17000000,
      sources: {
        hadModulesJson: true,
        hadSentenceBertConfig: true,
        hadSentenceTransformersConfig: false,
        hadOnnxDir: true,
        maxTokensFrom: 'sentence_bert_config',
      },
    });
    const { stdout } = await runModels(['check', 'Xenova/all-MiniLM-L6-v2']);
    const parsed = JSON.parse(stdout);
    expect(parsed.symmetric).toBe(true);
  });

  it('advertisedMaxTokens is present in the output', async () => {
    const { stdout } = await runModels(['check', 'Xenova/bge-small-en-v1.5']);
    const parsed = JSON.parse(stdout);
    expect(parsed.advertisedMaxTokens).toBe(512);
  });

  it('exits with error when getEmbeddingMetadata throws', async () => {
    mockGetEmbeddingMetadata.mockRejectedValue(new Error('config.json not reachable'));
    const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);

    await runModels(['check', 'bad/model']).catch(() => {});

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });

  it('--load flag also calls prefetchModel after metadata fetch', async () => {
    mockPrefetchModel.mockResolvedValue({
      model: 'Xenova/bge-small-en-v1.5',
      dim: 384,
      attempts: 1,
      cachedAt: '2026-04-23T00:00:00.000Z',
    });

    const { stdout } = await runModels(['check', 'Xenova/bge-small-en-v1.5', '--load']);
    const parsed = JSON.parse(stdout);

    expect(mockGetEmbeddingMetadata).toHaveBeenCalled();
    expect(mockPrefetchModel).toHaveBeenCalled();
    expect(parsed.loadedDim).toBe(384);
    expect(parsed.cachedAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// models refresh-cache (v1.7.5+)
// ---------------------------------------------------------------------------

describe('models refresh-cache', () => {
  let tmpDir: string;
  const origEnv = { ...process.env };

  beforeEach(async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'obs-cli-cache-'));
    process.env = { ...origEnv, VAULT_PATH: '/tmp/fake-vault', DATA_DIR: tmpDir };
  });

  afterEach(async () => {
    process.env = { ...origEnv };
    const fs = await import('node:fs');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('clears all cached metadata when called without --model', async () => {
    // Seed the DB with two cached rows directly via openDb + upsertCachedMetadata.
    const { openDb } = await import('../../src/store/db.js');
    const { upsertCachedMetadata, loadCachedMetadata } = await import('../../src/embeddings/metadata-cache.js');
    const path = await import('node:path');
    const dbPath = path.join(tmpDir, 'kg.db');
    const db = openDb(dbPath);
    upsertCachedMetadata(db, {
      modelId: 'a/b', dim: 384, maxTokens: 512, queryPrefix: '', documentPrefix: '',
      prefixSource: 'metadata', baseModel: null, sizeBytes: 100, fetchedAt: 1000,
    });
    upsertCachedMetadata(db, {
      modelId: 'c/d', dim: 768, maxTokens: 8192, queryPrefix: '', documentPrefix: '',
      prefixSource: 'readme', baseModel: null, sizeBytes: 200, fetchedAt: 2000,
    });
    db.close();

    const { stdout } = await runModels(['refresh-cache']);
    const parsed = JSON.parse(stdout);
    expect(parsed.scope).toBe('all');
    expect(parsed.rowsCleared).toBe(2);

    // Both entries are now invalidated.
    const db2 = openDb(dbPath);
    expect(loadCachedMetadata(db2, 'a/b')).toBeNull();
    expect(loadCachedMetadata(db2, 'c/d')).toBeNull();
    db2.close();
  });

  it('clears just one model when --model is provided', async () => {
    const { openDb } = await import('../../src/store/db.js');
    const { upsertCachedMetadata, loadCachedMetadata } = await import('../../src/embeddings/metadata-cache.js');
    const path = await import('node:path');
    const dbPath = path.join(tmpDir, 'kg.db');
    const db = openDb(dbPath);
    upsertCachedMetadata(db, {
      modelId: 'keep/me', dim: 384, maxTokens: 512, queryPrefix: '', documentPrefix: '',
      prefixSource: 'metadata', baseModel: null, sizeBytes: 100, fetchedAt: 1000,
    });
    upsertCachedMetadata(db, {
      modelId: 'drop/me', dim: 768, maxTokens: 8192, queryPrefix: '', documentPrefix: '',
      prefixSource: 'readme', baseModel: null, sizeBytes: 200, fetchedAt: 2000,
    });
    db.close();

    const { stdout } = await runModels(['refresh-cache', '--model', 'drop/me']);
    const parsed = JSON.parse(stdout);
    expect(parsed.scope).toBe('drop/me');
    expect(parsed.rowsCleared).toBe(1);

    const db2 = openDb(dbPath);
    expect(loadCachedMetadata(db2, 'drop/me')).toBeNull();
    expect(loadCachedMetadata(db2, 'keep/me')).not.toBeNull();
    db2.close();
  });

  it('returns rowsCleared=0 when the cache is already empty', async () => {
    const { stdout } = await runModels(['refresh-cache']);
    const parsed = JSON.parse(stdout);
    expect(parsed.rowsCleared).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// models override (v1.7.5 user-config layer)
// ---------------------------------------------------------------------------

describe('models override', () => {
  let tmpConfigDir: string;
  let priorConfigEnv: string | undefined;

  beforeEach(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    tmpConfigDir = mkdtempSync(join(tmpdir(), 'obrain-cli-overrides-'));
    priorConfigEnv = process.env.OBSIDIAN_BRAIN_CONFIG_DIR;
    process.env.OBSIDIAN_BRAIN_CONFIG_DIR = tmpConfigDir;
    const { _resetOverridesCache } = await import('../../src/embeddings/overrides.js');
    _resetOverridesCache();
  });

  afterEach(async () => {
    if (priorConfigEnv === undefined) delete process.env.OBSIDIAN_BRAIN_CONFIG_DIR;
    else process.env.OBSIDIAN_BRAIN_CONFIG_DIR = priorConfigEnv;
    const { _resetOverridesCache } = await import('../../src/embeddings/overrides.js');
    _resetOverridesCache();
    const { rmSync } = await import('node:fs');
    rmSync(tmpConfigDir, { recursive: true, force: true });
  });

  it('--list returns count=0 when no overrides exist', async () => {
    const { stdout } = await runModels(['override', '--list']);
    const parsed = JSON.parse(stdout);
    expect(parsed.count).toBe(0);
    expect(parsed.overrides).toEqual({});
  });

  it('writes a maxTokens override and round-trips via --list', async () => {
    await runModels(['override', 'foo/bar', '--max-tokens', '1024']);
    const { stdout } = await runModels(['override', '--list']);
    const parsed = JSON.parse(stdout);
    expect(parsed.count).toBe(1);
    expect(parsed.overrides['foo/bar']).toEqual({ maxTokens: 1024 });
  });

  it('combines maxTokens + queryPrefix in a single call', async () => {
    await runModels(['override', 'foo/bar', '--max-tokens', '512', '--query-prefix', 'Q: ']);
    const { stdout } = await runModels(['override', '--list']);
    const parsed = JSON.parse(stdout);
    expect(parsed.overrides['foo/bar']).toEqual({ maxTokens: 512, queryPrefix: 'Q: ' });
  });

  it('--remove --field clears just that field, leaves the rest', async () => {
    await runModels(['override', 'foo/bar', '--max-tokens', '512', '--query-prefix', 'Q: ']);
    await runModels(['override', 'foo/bar', '--remove', '--field', 'maxTokens']);
    const { stdout } = await runModels(['override', '--list']);
    const parsed = JSON.parse(stdout);
    expect(parsed.overrides['foo/bar']).toEqual({ queryPrefix: 'Q: ' });
  });

  it('--remove without --field deletes the entire entry', async () => {
    await runModels(['override', 'foo/bar', '--max-tokens', '512']);
    await runModels(['override', 'foo/bar', '--remove']);
    const { stdout } = await runModels(['override', '--list']);
    const parsed = JSON.parse(stdout);
    expect(parsed.count).toBe(0);
  });

  it('rejects --max-tokens 0 with a non-zero exit', async () => {
    await expect(runModels(['override', 'foo/bar', '--max-tokens', '0'])).rejects.toThrow();
  });

  it('rejects calls with no override fields specified', async () => {
    await expect(runModels(['override', 'foo/bar'])).rejects.toThrow();
  });

  it('rejects --remove --field with an unknown field name', async () => {
    await runModels(['override', 'foo/bar', '--max-tokens', '512']);
    await expect(
      runModels(['override', 'foo/bar', '--remove', '--field', 'bogus']),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// models fetch-seed (v1.7.5 user-fetched seed layer)
// ---------------------------------------------------------------------------

describe('models fetch-seed', () => {
  let tmpConfigDir: string;
  let priorConfigEnv: string | undefined;
  let priorFetch: typeof fetch;

  beforeEach(async () => {
    const { mkdtempSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    tmpConfigDir = mkdtempSync(join(tmpdir(), 'obrain-cli-fetchseed-'));
    priorConfigEnv = process.env.OBSIDIAN_BRAIN_CONFIG_DIR;
    process.env.OBSIDIAN_BRAIN_CONFIG_DIR = tmpConfigDir;
    priorFetch = globalThis.fetch;
  });

  afterEach(async () => {
    if (priorConfigEnv === undefined) delete process.env.OBSIDIAN_BRAIN_CONFIG_DIR;
    else process.env.OBSIDIAN_BRAIN_CONFIG_DIR = priorConfigEnv;
    globalThis.fetch = priorFetch;
    const { rmSync } = await import('node:fs');
    rmSync(tmpConfigDir, { recursive: true, force: true });
  });

  function mockFetch(payload: string, status = 200): void {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Not Found',
      text: async () => payload,
    } as Response) as unknown as typeof fetch;
  }

  it('--check validates without writing to disk', async () => {
    mockFetch(JSON.stringify({
      $schemaVersion: 2,
      $generatedAt: 1,
      models: { 'foo/bar': { maxTokens: 512, queryPrefix: null, documentPrefix: null } },
    }));
    const { stdout } = await runModels(['fetch-seed', '--check']);
    const parsed = JSON.parse(stdout);
    expect(parsed.wrote).toBe(false);
    expect(parsed.entries).toBe(1);
    expect(parsed.schemaVersion).toBe(2);
    const { existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    expect(existsSync(join(tmpConfigDir, 'seed-models.json'))).toBe(false);
  });

  it('writes the user-seed file when not in --check mode', async () => {
    mockFetch(JSON.stringify({
      $schemaVersion: 2,
      $generatedAt: 1,
      models: { 'foo/bar': { maxTokens: 512, queryPrefix: null, documentPrefix: null } },
    }));
    const { stdout } = await runModels(['fetch-seed']);
    const parsed = JSON.parse(stdout);
    expect(parsed.wrote).toContain('seed-models.json');
    const { readFileSync } = await import('node:fs');
    const written = JSON.parse(readFileSync(parsed.wrote, 'utf-8'));
    expect(written.$schemaVersion).toBe(2);
  });

  it('refuses to write when $schemaVersion is unsupported', async () => {
    mockFetch(JSON.stringify({ $schemaVersion: 99, models: {} }));
    await expect(runModels(['fetch-seed'])).rejects.toThrow();
  });

  it('refuses to write on HTTP error', async () => {
    mockFetch('', 404);
    await expect(runModels(['fetch-seed'])).rejects.toThrow();
  });

  it('refuses to write when response is invalid JSON', async () => {
    mockFetch('{ not json');
    await expect(runModels(['fetch-seed'])).rejects.toThrow();
  });

  it('refuses to write when models object is missing', async () => {
    mockFetch(JSON.stringify({ $schemaVersion: 2 }));
    await expect(runModels(['fetch-seed'])).rejects.toThrow();
  });

  it('refuses to write a zero-entry seed', async () => {
    mockFetch(JSON.stringify({ $schemaVersion: 2, models: {} }));
    await expect(runModels(['fetch-seed'])).rejects.toThrow();
  });
});
