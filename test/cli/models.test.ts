/**
 * Unit tests for src/cli/models.ts
 *
 * Strategy: import `registerModelsCommands`, attach it to a Commander
 * program, and invoke actions directly by calling
 * `program.parseAsync(['node', 'cli', 'models', ...args])`. Capture
 * stdout/stderr by replacing `process.stdout.write` and
 * `process.stderr.write` with spies. Mock heavy dependencies
 * (prefetchModel, recommendPreset) so no real network calls are made.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';

// ---------------------------------------------------------------------------
// Use vi.hoisted() to declare mock functions before vi.mock() factories run.
// This is the correct vitest pattern for mocking named exports that need to
// be spied on in tests.
// ---------------------------------------------------------------------------

const { mockPrefetchModel, mockAutoRecommendPreset } = vi.hoisted(() => ({
  mockPrefetchModel: vi.fn(),
  mockAutoRecommendPreset: vi.fn(),
}));

vi.mock('../../src/embeddings/prefetch.js', () => ({
  prefetchModel: mockPrefetchModel,
}));

vi.mock('../../src/embeddings/auto-recommend.js', () => ({
  autoRecommendPreset: mockAutoRecommendPreset,
}));

import { registerModelsCommands } from '../../src/cli/models.js';
import { EMBEDDING_PRESETS } from '../../src/embeddings/presets.js';
import { getTransformersPrefix } from '../../src/embeddings/embedder.js';

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
    .exitOverride() // prevent commander from calling process.exit
    .configureOutput({
      writeErr: () => {}, // suppress commander's own error output
    });

  registerModelsCommands(program);

  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const origStdout = process.stdout.write.bind(process.stdout);
  const origStderr = process.stderr.write.bind(process.stderr);

  // Override write methods (signature: (chunk, encoding?, callback?) => boolean)
  (process.stdout as unknown as { write: (chunk: unknown) => boolean }).write = (
    chunk: unknown,
  ) => {
    stdoutChunks.push(String(chunk));
    return true;
  };
  (process.stderr as unknown as { write: (chunk: unknown) => boolean }).write = (
    chunk: unknown,
  ) => {
    stderrChunks.push(String(chunk));
    return true;
  };

  try {
    await program.parseAsync(['node', 'cli', 'models', ...args]);
  } finally {
    process.stdout.write = origStdout;
    process.stderr.write = origStderr;
  }

  return {
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
  };
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

  it('JSON output has expected fields per entry', async () => {
    const { stdout } = await runModels(['list']);
    const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;
    expect(parsed.length).toBeGreaterThan(0);
    for (const entry of parsed) {
      expect(entry).toHaveProperty('preset');
      expect(entry).toHaveProperty('model');
      expect(entry).toHaveProperty('sizeMb');
      expect(entry).toHaveProperty('lang');
      expect(entry).toHaveProperty('symmetric');
    }
  });

  it('stdout is always valid JSON regardless of TTY state (non-TTY)', async () => {
    // stdout.isTTY is undefined/false in test env — this is the non-TTY path.
    const { stdout, stderr } = await runModels(['list']);
    expect(() => JSON.parse(stdout)).not.toThrow();
    // In non-TTY mode, the human-readable table is NOT written to stderr.
    expect(stderr).not.toContain('Embedding presets:');
  });

  it('stderr table is written when stdout is a TTY', async () => {
    // Simulate TTY.
    const origIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdout, 'isTTY', {
      value: true,
      configurable: true,
    });

    const { stdout, stderr } = await runModels(['list']);

    Object.defineProperty(process.stdout, 'isTTY', {
      value: origIsTTY,
      configurable: true,
    });

    // stdout still has valid JSON.
    expect(() => JSON.parse(stdout)).not.toThrow();
    // stderr has the human table.
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
    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as never);

    await runModels(['recommend']).catch(() => {});

    // process.exit(1) should have been called.
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

  it('"balanced" is a deprecated alias no longer present in EMBEDDING_PRESETS — exits with error', async () => {
    // Previously "balanced" resolved to Xenova/all-MiniLM-L6-v2 (old preset).
    // That preset was removed; "balanced" is now a deprecated alias in presets.ts
    // that maps to "english" (Xenova/bge-small-en-v1.5) via resolveEmbeddingModel.
    // The prefetch subcommand looks up EMBEDDING_PRESETS directly (no alias
    // resolution), so "balanced" is an unknown preset and must exit(1).
    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as never);

    await runModels(['prefetch', 'balanced']).catch(() => {});

    expect(mockExit).toHaveBeenCalledWith(1);
    // Critically: prefetchModel must NOT have been called with all-MiniLM-L6-v2.
    const calledModels = mockPrefetchModel.mock.calls.map((c) => c[0] as string);
    expect(calledModels).not.toContain('Xenova/all-MiniLM-L6-v2');
    mockExit.mockRestore();
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
    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as never);

    await runModels(['prefetch', 'nonexistent-preset']).catch(() => {});

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });

  // SLOW_TESTS integration
  if (process.env.SLOW_TESTS === '1') {
    it(
      'integration: actually downloads english model',
      async () => {
        // Reset mock to use real implementation — only feasible in a real env.
        vi.mocked(mockPrefetchModel).mockImplementation(
          async (model: string) => {
            const { prefetchModel: real } = await import(
              '../../src/embeddings/prefetch.js'
            );
            return real(model);
          },
        );
        await runModels(['prefetch', 'english']);
        const calls = mockPrefetchModel.mock.calls;
        expect(calls.length).toBeGreaterThan(0);
      },
      300_000,
    );
  }
});

// ---------------------------------------------------------------------------
// models check
// ---------------------------------------------------------------------------

describe('models check', () => {
  beforeEach(() => {
    mockPrefetchModel.mockReset();
    mockPrefetchModel.mockResolvedValue({
      model: 'Xenova/bge-small-en-v1.5',
      dim: 384,
      attempts: 1,
      cachedAt: '2026-04-23T00:00:00.000Z',
    });
  });

  it('calls prefetchModel with the provided id', async () => {
    await runModels(['check', 'Xenova/bge-small-en-v1.5']);
    expect(mockPrefetchModel).toHaveBeenCalledWith(
      'Xenova/bge-small-en-v1.5',
      expect.objectContaining({ backoffBaseMs: 1000 }),
    );
  });

  it('output JSON has dim, symmetric, expectedQueryPrefix, ready', async () => {
    const { stdout } = await runModels(['check', 'Xenova/bge-small-en-v1.5']);
    const parsed = JSON.parse(stdout);

    expect(parsed.model).toBe('Xenova/bge-small-en-v1.5');
    expect(parsed.dim).toBe(384);
    expect(typeof parsed.symmetric).toBe('boolean');
    expect(typeof parsed.expectedQueryPrefix).toBe('string');
    expect(parsed.ready).toBe(true);
  });

  it('bge model is symmetric=false', async () => {
    const { stdout } = await runModels(['check', 'Xenova/bge-small-en-v1.5']);
    const parsed = JSON.parse(stdout);
    expect(parsed.symmetric).toBe(false);
  });

  it('MiniLM model is symmetric=true', async () => {
    mockPrefetchModel.mockResolvedValue({
      model: 'Xenova/all-MiniLM-L6-v2',
      dim: 384,
      attempts: 1,
      cachedAt: '2026-04-23T00:00:00.000Z',
    });

    const { stdout } = await runModels(['check', 'Xenova/all-MiniLM-L6-v2']);
    const parsed = JSON.parse(stdout);
    expect(parsed.symmetric).toBe(true);
  });

  it('bge query prefix matches getTransformersPrefix', async () => {
    const { stdout } = await runModels(['check', 'Xenova/bge-small-en-v1.5']);
    const parsed = JSON.parse(stdout);
    const expected = getTransformersPrefix('Xenova/bge-small-en-v1.5', 'query');
    expect(parsed.expectedQueryPrefix).toBe(expected);
  });

  it('advertisedMaxTokens is present (may be null for unknown models)', async () => {
    mockPrefetchModel.mockResolvedValue({
      model: 'some/unknown-model',
      dim: 768,
      attempts: 1,
      cachedAt: '2026-04-23T00:00:00.000Z',
    });

    const { stdout } = await runModels(['check', 'some/unknown-model']);
    const parsed = JSON.parse(stdout);
    // advertisedMaxTokens may be null but must be present.
    expect('advertisedMaxTokens' in parsed).toBe(true);
  });

  it('exits with error when prefetchModel throws', async () => {
    mockPrefetchModel.mockRejectedValue(new Error('download failed'));
    const mockExit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => {}) as never);

    await runModels(['check', 'bad/model']).catch(() => {});

    expect(mockExit).toHaveBeenCalledWith(1);
    mockExit.mockRestore();
  });

  // SLOW_TESTS integration
  if (process.env.SLOW_TESTS === '1') {
    it(
      'integration: checks bge-small-en-v1.5 end-to-end',
      async () => {
        vi.mocked(mockPrefetchModel).mockImplementation(
          async (model: string) => {
            const { prefetchModel: real } = await import(
              '../../src/embeddings/prefetch.js'
            );
            return real(model);
          },
        );
        const { stdout } = await runModels(['check', 'Xenova/bge-small-en-v1.5']);
        const parsed = JSON.parse(stdout);
        expect(parsed.dim).toBe(384);
        expect(parsed.ready).toBe(true);
      },
      300_000,
    );
  }
});
