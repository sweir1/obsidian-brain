import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EmbedderLoadError } from '../../src/embeddings/errors.js';

// Mock @huggingface/transformers at the module level so TransformersEmbedder
// never touches the network or real ONNX files in this test suite.
vi.mock('@huggingface/transformers', () => ({
  pipeline: vi.fn(),
  env: { cacheDir: '' },
}));

// Import after the mock is set up.
import { pipeline } from '@huggingface/transformers';
import { TransformersEmbedder } from '../../src/embeddings/embedder.js';

const mockPipeline = pipeline as ReturnType<typeof vi.fn>;

describe('TransformersEmbedder.init() — EmbedderLoadError classification', () => {
  let stderrLines: string[] = [];
  let originalStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    stderrLines = [];
    originalStderrWrite = process.stderr.write.bind(process.stderr);
    // Capture stderr without outputting it during tests
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderrLines.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    mockPipeline.mockReset();
  });

  it('classifies a 404 response as not-found', async () => {
    mockPipeline.mockRejectedValue(new Error('404 not found: MyOrg/my-model'));

    const embedder = new TransformersEmbedder('MyOrg/my-model');
    await expect(embedder.init()).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(EmbedderLoadError);
      const err = e as EmbedderLoadError;
      expect(err.kind).toBe('not-found');
      expect(err.message).toContain('MyOrg/my-model');
      return true;
    });
  });

  it('classifies a missing ONNX file as no-onnx', async () => {
    mockPipeline.mockRejectedValue(
      new Error('Could not locate file: model.onnx for model SomeOrg/model'),
    );

    const embedder = new TransformersEmbedder('SomeOrg/model');
    await expect(embedder.init()).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(EmbedderLoadError);
      const err = e as EmbedderLoadError;
      expect(err.kind).toBe('no-onnx');
      expect(err.message).toContain('SomeOrg/model');
      expect(err.message).toContain('ONNX');
      return true;
    });
  });

  it('classifies an ENOTFOUND network error as offline', async () => {
    mockPipeline.mockRejectedValue(
      new Error('getaddrinfo ENOTFOUND api-inference.huggingface.co'),
    );

    const embedder = new TransformersEmbedder('Xenova/all-MiniLM-L6-v2');
    await expect(embedder.init()).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(EmbedderLoadError);
      const err = e as EmbedderLoadError;
      expect(err.kind).toBe('offline');
      expect(err.message).toContain('Xenova/all-MiniLM-L6-v2');
      expect(err.message).toContain('internet');
      return true;
    });
  });

  it('classifies an unknown/unmapped error as unknown with original message', async () => {
    mockPipeline.mockRejectedValue(new Error('Unknown weird error message from transformers'));

    const embedder = new TransformersEmbedder('Xenova/all-MiniLM-L6-v2');
    await expect(embedder.init()).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(EmbedderLoadError);
      const err = e as EmbedderLoadError;
      expect(err.kind).toBe('unknown');
      // Original message must be included verbatim in the wrapper
      expect(err.message).toContain('Unknown weird error message from transformers');
      return true;
    });
  });

  it('preserves the original Error instance as .cause on the wrapper', async () => {
    const originalError = new Error('Original transformers error');
    mockPipeline.mockRejectedValue(originalError);

    const embedder = new TransformersEmbedder('Xenova/all-MiniLM-L6-v2');
    await expect(embedder.init()).rejects.toSatisfy((e: unknown) => {
      expect(e).toBeInstanceOf(EmbedderLoadError);
      const err = e as EmbedderLoadError;
      expect(err.cause).toBe(originalError);
      return true;
    });
  });

  it('writes stderr fallthrough log ONLY for unknown kind', async () => {
    mockPipeline.mockRejectedValue(new Error('Unknown weird error message from transformers'));

    const embedder = new TransformersEmbedder('Xenova/all-MiniLM-L6-v2');
    await expect(embedder.init()).rejects.toBeInstanceOf(EmbedderLoadError);

    // Should have written the "please report" message to stderr
    expect(stderrLines.some((l) => l.includes('unmapped embedder error'))).toBe(true);
    expect(stderrLines.some((l) => l.includes('please report this message verbatim'))).toBe(true);
  });

  it('does NOT write the fallthrough stderr log for not-found kind', async () => {
    mockPipeline.mockRejectedValue(new Error('404 not found: SomeOrg/bad-model'));

    const embedder = new TransformersEmbedder('SomeOrg/bad-model');
    await expect(embedder.init()).rejects.toBeInstanceOf(EmbedderLoadError);

    // Should NOT have written the "please report" / "unmapped" fallthrough message
    expect(stderrLines.some((l) => l.includes('unmapped embedder error'))).toBe(false);
  });

  it('does NOT write the fallthrough stderr log for no-onnx kind', async () => {
    mockPipeline.mockRejectedValue(
      new Error('Could not locate file: model.onnx for SomeOrg/model'),
    );

    const embedder = new TransformersEmbedder('SomeOrg/model');
    await expect(embedder.init()).rejects.toBeInstanceOf(EmbedderLoadError);

    expect(stderrLines.some((l) => l.includes('unmapped embedder error'))).toBe(false);
  });

  it('does NOT write the fallthrough stderr log for offline kind', async () => {
    mockPipeline.mockRejectedValue(
      new Error('getaddrinfo ENOTFOUND api-inference.huggingface.co'),
    );

    const embedder = new TransformersEmbedder('Xenova/all-MiniLM-L6-v2');
    await expect(embedder.init()).rejects.toBeInstanceOf(EmbedderLoadError);

    expect(stderrLines.some((l) => l.includes('unmapped embedder error'))).toBe(false);
  });

  it('re-throws an EmbedderLoadError as-is without double-wrapping', async () => {
    const alreadyClassified = new EmbedderLoadError(
      'not-found',
      "Model 'x' not found on Hugging Face.",
    );
    mockPipeline.mockRejectedValue(alreadyClassified);

    const embedder = new TransformersEmbedder('x');
    await expect(embedder.init()).rejects.toSatisfy((e: unknown) => {
      // Must be exactly the same object — not double-wrapped
      expect(e).toBe(alreadyClassified);
      return true;
    });
  });
});
