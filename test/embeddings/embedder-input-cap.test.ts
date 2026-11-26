/**
 * Defense in depth for GitHub issue #26: transformers.js pre-tokenises the
 * whole input before truncating to the model window, and that step stalls on
 * 100+ KB strings. embed() caps the character length up-front. These tests
 * swap in a fake extractor so no model download is needed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  TransformersEmbedder,
  embedInputCharCap,
  capEmbedInput,
} from '../../src/embeddings/embedder.js';
import type { EmbedderMetadata } from '../../src/embeddings/types.js';
import { logger } from '../../src/util/logger.js';

function withFakeExtractor(emb: TransformersEmbedder): string[] {
  const seen: string[] = [];
  const fake = Object.assign(
    async (text: string) => {
      seen.push(text);
      return { tolist: () => [[0.1, 0.2, 0.3]] };
    },
    { dispose: async () => {} },
  );
  (emb as unknown as { extractor: unknown }).extractor = fake;
  return seen;
}

function meta(maxTokens: number, documentPrefix = ''): EmbedderMetadata {
  return {
    modelId: 'Xenova/test-model',
    dim: 3,
    maxTokens,
    queryPrefix: '',
    documentPrefix,
    prefixSource: 'seed',
    baseModel: null,
    sizeBytes: null,
  };
}

describe('embedInputCharCap', () => {
  it('uses the 8192 floor when metadata is missing or nonsensical', () => {
    expect(embedInputCharCap(undefined)).toBe(8192);
    expect(embedInputCharCap(null)).toBe(8192);
    expect(embedInputCharCap(0)).toBe(8192);
    expect(embedInputCharCap(128)).toBe(8192);
  });

  it('scales with the model window and is bounded by the ceiling', () => {
    expect(embedInputCharCap(512)).toBe(8192);
    expect(embedInputCharCap(2048)).toBe(32_768);
    expect(embedInputCharCap(8192)).toBe(65_536);
    expect(embedInputCharCap(1_000_000)).toBe(65_536);
  });
});

describe('capEmbedInput', () => {
  it('returns short input unchanged', () => {
    expect(capEmbedInput('hello', 10)).toBe('hello');
  });

  it('truncates long input to the cap', () => {
    expect(capEmbedInput('abcdefghij', 4)).toBe('abcd');
  });

  it('does not leave a lone high surrogate at the cut', () => {
    const s = 'ab' + '\u{1F600}' + 'cd'; // a b [hi lo] c d
    expect(capEmbedInput(s, 3)).toBe('ab');
    expect(capEmbedInput(s, 4)).toBe('ab\u{1F600}');
  });
});

describe('TransformersEmbedder.embed input cap', () => {
  afterEach(() => vi.restoreAllMocks());

  it('passes normal-sized input through untouched', async () => {
    const emb = new TransformersEmbedder('Xenova/test-model');
    const seen = withFakeExtractor(emb);
    const vec = await emb.embed('short text');
    expect(seen).toEqual(['short text']);
    expect(Array.from(vec)).toHaveLength(3);
  });

  it('caps a 150 KB input before it reaches the tokenizer and logs a warning', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const emb = new TransformersEmbedder('Xenova/test-model');
    emb.setMetadata(meta(512, 'passage: '));
    const seen = withFakeExtractor(emb);
    await emb.embed('x'.repeat(150_000), 'document');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toBe('passage: ' + 'x'.repeat(8192));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toMatch(/truncated from 150000 to 8192/);
  });

  it('applies the cap before multi-{text} template substitution', async () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const emb = new TransformersEmbedder('Xenova/test-model');
    emb.setMetadata(meta(512, 'A: {text}\nB: {text}'));
    const seen = withFakeExtractor(emb);
    await emb.embed('y'.repeat(20_000), 'document');
    const capped = 'y'.repeat(8192);
    expect(seen[0]).toBe(`A: ${capped}\nB: ${capped}`);
  });
});
