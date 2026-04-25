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
      // dim/sizeMb/symmetric come from the bundled seed JSON; null for any
      // preset not yet in seed (anchor seed covers all 6 canonical presets).
      expect(entry).toHaveProperty('dim');
      expect(entry).toHaveProperty('sizeMb');
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
