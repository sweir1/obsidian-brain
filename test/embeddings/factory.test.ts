import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEmbedder } from '../../src/embeddings/factory.js';
import { TransformersEmbedder } from '../../src/embeddings/embedder.js';
import { OllamaEmbedder } from '../../src/embeddings/ollama.js';
import { OpenAICompatibleEmbedder } from '../../src/embeddings/openai-compatible.js';
import {
  EMBEDDING_PRESETS,
  DEFAULT_OLLAMA_MODEL,
  DEFAULT_OPENAI_COMPATIBLE_MODEL,
  type EmbeddingPresetName,
} from '../../src/embeddings/presets.js';

const ENV_KEYS = [
  'EMBEDDING_PROVIDER',
  'EMBEDDING_PRESET',
  'EMBEDDING_MODEL',
  'OLLAMA_BASE_URL',
  'OLLAMA_EMBEDDING_DIM',
  'EMBEDDING_BASE_URL',
  'EMBEDDING_DIM',
  'EMBEDDING_API_KEY',
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) snap[k] = process.env[k];
  return snap;
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    const v = snap[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

describe('createEmbedder (factory)', () => {
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    // Start each test with a clean slate.
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  it('defaults to TransformersEmbedder when EMBEDDING_PROVIDER is unset', () => {
    const e = createEmbedder();
    expect(e).toBeInstanceOf(TransformersEmbedder);
  });

  it('returns TransformersEmbedder when EMBEDDING_PROVIDER=transformers', () => {
    process.env.EMBEDDING_PROVIDER = 'transformers';
    const e = createEmbedder();
    expect(e).toBeInstanceOf(TransformersEmbedder);
  });

  it('is case-insensitive on the provider name', () => {
    process.env.EMBEDDING_PROVIDER = 'OLLAMA';
    process.env.OLLAMA_EMBEDDING_DIM = '768';
    const e = createEmbedder();
    expect(e).toBeInstanceOf(OllamaEmbedder);
  });

  it('returns OllamaEmbedder when EMBEDDING_PROVIDER=ollama', () => {
    process.env.EMBEDDING_PROVIDER = 'ollama';
    process.env.OLLAMA_EMBEDDING_DIM = '768';
    const e = createEmbedder();
    expect(e).toBeInstanceOf(OllamaEmbedder);
    // With declared dim the embedder can answer dimensions() synchronously.
    expect(e.dimensions()).toBe(768);
    expect(e.modelIdentifier()).toBe('ollama:nomic-embed-text');
    expect(e.providerName()).toBe('ollama');
  });

  it('honours OLLAMA_BASE_URL + EMBEDDING_MODEL overrides', () => {
    process.env.EMBEDDING_PROVIDER = 'ollama';
    process.env.OLLAMA_BASE_URL = 'http://192.168.1.50:11434';
    process.env.EMBEDDING_MODEL = 'mxbai-embed-large';
    process.env.OLLAMA_EMBEDDING_DIM = '1024';
    const e = createEmbedder();
    expect(e).toBeInstanceOf(OllamaEmbedder);
    expect(e.modelIdentifier()).toBe('ollama:mxbai-embed-large');
    expect(e.dimensions()).toBe(1024);
  });

  it('Ollama without declared dim: dimensions() throws until init/embed runs', () => {
    process.env.EMBEDDING_PROVIDER = 'ollama';
    const e = createEmbedder();
    expect(e).toBeInstanceOf(OllamaEmbedder);
    expect(() => e.dimensions()).toThrow(/dimensions not known yet/i);
  });

  it('throws on unknown provider with a list of supported values', () => {
    // NB: 'openai' was this test's stand-in for "unknown" until v1.7.25 made
    // it an alias of the openai-compatible provider. Use a provider we have
    // no intention of ever supporting so the test can't silently invert again.
    process.env.EMBEDDING_PROVIDER = 'cohere';
    expect(() => createEmbedder()).toThrow(
      /Unknown EMBEDDING_PROVIDER='cohere'.*transformers.*ollama.*openai-compatible/s,
    );
  });

  it.each(['openai-compatible', 'openai', 'llamacpp', 'llama.cpp', 'lmstudio', 'vllm', 'tei'])(
    'EMBEDDING_PROVIDER=%s resolves to the OpenAI-compatible embedder',
    (alias) => {
      process.env.EMBEDDING_PROVIDER = alias;
      const e = createEmbedder();
      expect(e).toBeInstanceOf(OpenAICompatibleEmbedder);
      expect(e.providerName()).toBe('openai-compatible');
    },
  );

  it('OpenAI-compatible without declared dim: dimensions() throws until init/embed runs', () => {
    process.env.EMBEDDING_PROVIDER = 'llamacpp';
    const e = createEmbedder();
    expect(() => e.dimensions()).toThrow(/dimensions not known yet/i);
  });

  it('rejects a non-numeric EMBEDDING_DIM', () => {
    process.env.EMBEDDING_PROVIDER = 'llamacpp';
    process.env.EMBEDDING_DIM = 'one thousand and twenty four';
    expect(() => createEmbedder()).toThrow(/EMBEDDING_DIM.*not a positive number/);
  });

  it('EMBEDDING_BASE_URL is honored, and a trailing /v1 is not doubled', () => {
    process.env.EMBEDDING_PROVIDER = 'llamacpp';
    process.env.EMBEDDING_BASE_URL = 'http://127.0.0.1:8082/v1/';
    const e = createEmbedder() as OpenAICompatibleEmbedder;
    expect(e.baseUrl).toBe('http://127.0.0.1:8082');
  });

  it('rejects a non-numeric OLLAMA_EMBEDDING_DIM', () => {
    process.env.EMBEDDING_PROVIDER = 'ollama';
    process.env.OLLAMA_EMBEDDING_DIM = 'seven hundred and sixty-eight';
    expect(() => createEmbedder()).toThrow(/OLLAMA_EMBEDDING_DIM.*not a positive number/);
  });

  it('rejects a zero/negative OLLAMA_EMBEDDING_DIM', () => {
    process.env.EMBEDDING_PROVIDER = 'ollama';
    process.env.OLLAMA_EMBEDDING_DIM = '0';
    expect(() => createEmbedder()).toThrow(/OLLAMA_EMBEDDING_DIM.*not a positive number/);
  });

  // v1.7.23: confirm the factory plumbs `presetName` from resolvePresetConfig
  // through the constructor's 5th argument. If this regresses (someone drops
  // the arg in factory.ts), the BYOM auto-pull gate silently falls back to
  // treating EVERY model as BYOM, which would break preset users' auto-pull.
  it('v1.7.23: passes preset name through to OllamaEmbedder for preset path', () => {
    process.env.EMBEDDING_PRESET = 'multilingual-ollama';
    process.env.OLLAMA_EMBEDDING_DIM = '1024';
    const e = createEmbedder();
    expect(e).toBeInstanceOf(OllamaEmbedder);
    expect((e as OllamaEmbedder).presetNameForTest).toBe('multilingual-ollama');
  });

  it('v1.7.23: passes null preset name for BYOM (EMBEDDING_MODEL, no preset)', () => {
    process.env.EMBEDDING_PROVIDER = 'ollama';
    process.env.EMBEDDING_MODEL = 'user/custom-fork';
    process.env.OLLAMA_EMBEDDING_DIM = '768';
    const e = createEmbedder();
    expect(e).toBeInstanceOf(OllamaEmbedder);
    expect((e as OllamaEmbedder).presetNameForTest).toBeNull();
  });
});

/**
 * Preset-resolution integration tests — added in v1.7.8 to catch the
 * Bug 2 class: factory bypassing the preset registry. These exercise
 * `createEmbedder()` end-to-end against every preset, asserting the
 * resulting embedder is configured with the preset's declared model
 * AND provider together (atomically). The pre-v1.7.8 Ollama branch
 * hardcoded `'nomic-embed-text'` and ignored EMBEDDING_PRESET; this
 * suite would have failed `multilingual-ollama → qwen3-embedding:0.6b`
 * on the v1.7.5 Plan B preset addition.
 */
describe('createEmbedder — preset resolution (Bug 2 regression suite)', () => {
  let envSnapshot: Record<string, string | undefined>;

  beforeEach(() => {
    envSnapshot = snapshotEnv();
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    restoreEnv(envSnapshot);
  });

  // Property-based — iterates EMBEDDING_PRESETS at test time. Adding a new
  // preset to presets.ts automatically extends this suite. Changing a preset's
  // underlying model does NOT require a test edit (the assertion is "factory
  // returns whatever model the preset declares", not "factory returns this
  // specific string"). The change-detector signal for intentional preset
  // model swaps lives in `test/cli/models.test.ts`'s snapshot of the
  // `models list` CLI output — that's the right place to surface a "you
  // changed user-facing behavior, update CHANGELOG" moment.
  const presetEntries = Object.entries(EMBEDDING_PRESETS) as Array<
    [EmbeddingPresetName, (typeof EMBEDDING_PRESETS)[EmbeddingPresetName]]
  >;
  it.each(presetEntries)(
    'EMBEDDING_PRESET=%s → embedder honors preset.model + preset.provider atomically',
    (presetName, preset) => {
      process.env.EMBEDDING_PRESET = presetName;
      // Declare dim up-front so dimensions() can be called without init().
      if (preset.provider === 'ollama') process.env.OLLAMA_EMBEDDING_DIM = '1024';
      if (preset.provider === 'openai-compatible') process.env.EMBEDDING_DIM = '1024';
      const e = createEmbedder();
      if (preset.provider === 'ollama') {
        expect(e).toBeInstanceOf(OllamaEmbedder);
        expect(e.modelIdentifier()).toBe(`ollama:${preset.model}`);
        expect(e.providerName()).toBe('ollama');
      } else if (preset.provider === 'openai-compatible') {
        expect(e).toBeInstanceOf(OpenAICompatibleEmbedder);
        expect(e.modelIdentifier()).toBe(`openai:${preset.model}`);
        expect(e.providerName()).toBe('openai-compatible');
      } else {
        expect(e).toBeInstanceOf(TransformersEmbedder);
        expect(e.modelIdentifier()).toContain(preset.model);
      }
    },
  );

  it('EMBEDDING_PROVIDER=llamacpp only (no preset, no model) → DEFAULT_OPENAI_COMPATIBLE_MODEL', () => {
    process.env.EMBEDDING_PROVIDER = 'llamacpp';
    process.env.EMBEDDING_DIM = '1024';
    const e = createEmbedder();
    expect(e).toBeInstanceOf(OpenAICompatibleEmbedder);
    expect(e.modelIdentifier()).toBe(`openai:${DEFAULT_OPENAI_COMPATIBLE_MODEL}`);
  });

  it('EMBEDDING_MODEL + EMBEDDING_PROVIDER=llamacpp → raw model on the new provider', () => {
    process.env.EMBEDDING_PROVIDER = 'llamacpp';
    process.env.EMBEDDING_MODEL = 'Qwen/Qwen3-Embedding-4B';
    process.env.EMBEDDING_DIM = '2560';
    const e = createEmbedder();
    expect(e).toBeInstanceOf(OpenAICompatibleEmbedder);
    expect(e.modelIdentifier()).toBe('openai:Qwen/Qwen3-Embedding-4B');
    expect(e.dimensions()).toBe(2560);
  });

  it('EMBEDDING_PROVIDER=ollama only (no preset, no model) → DEFAULT_OLLAMA_MODEL', () => {
    process.env.EMBEDDING_PROVIDER = 'ollama';
    process.env.OLLAMA_EMBEDDING_DIM = '768';
    const e = createEmbedder();
    expect(e).toBeInstanceOf(OllamaEmbedder);
    expect(e.modelIdentifier()).toBe(`ollama:${DEFAULT_OLLAMA_MODEL}`);
  });

  it('EMBEDDING_MODEL set + no EMBEDDING_PROVIDER → assumes transformers (legacy)', () => {
    process.env.EMBEDDING_MODEL = 'BAAI/bge-large-en-v1.5';
    const e = createEmbedder();
    expect(e).toBeInstanceOf(TransformersEmbedder);
    expect(e.modelIdentifier()).toContain('BAAI/bge-large-en-v1.5');
  });

  it('EMBEDDING_MODEL + EMBEDDING_PROVIDER=ollama → uses model on ollama', () => {
    process.env.EMBEDDING_MODEL = 'mxbai-embed-large';
    process.env.EMBEDDING_PROVIDER = 'ollama';
    process.env.OLLAMA_EMBEDDING_DIM = '1024';
    const e = createEmbedder();
    expect(e).toBeInstanceOf(OllamaEmbedder);
    expect(e.modelIdentifier()).toBe('ollama:mxbai-embed-large');
  });
});
