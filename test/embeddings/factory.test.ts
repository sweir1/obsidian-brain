import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createEmbedder } from '../../src/embeddings/factory.js';
import { TransformersEmbedder } from '../../src/embeddings/embedder.js';
import { OllamaEmbedder } from '../../src/embeddings/ollama.js';

const ENV_KEYS = [
  'EMBEDDING_PROVIDER',
  'EMBEDDING_MODEL',
  'OLLAMA_BASE_URL',
  'OLLAMA_EMBEDDING_DIM',
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
    process.env.EMBEDDING_PROVIDER = 'openai';
    expect(() => createEmbedder()).toThrow(
      /Unknown EMBEDDING_PROVIDER='openai'.*transformers.*ollama/s,
    );
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
});
