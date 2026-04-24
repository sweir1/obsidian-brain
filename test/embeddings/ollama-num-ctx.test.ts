import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OllamaEmbedder } from '../../src/embeddings/ollama.js';

// Minimal fake of the Fetch Response shape our embedder inspects.
function ok(embedding: number[]): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => ({ embedding }),
    text: async () => '',
  } as unknown as Response;
}

describe('OllamaEmbedder — num_ctx in request body', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.unstubAllEnvs();
  });

  it('default: body contains options.num_ctx of 8192', async () => {
    fetchMock.mockResolvedValueOnce(ok([0.1, 0.2, 0.3]));
    const e = new OllamaEmbedder();
    await e.embed('hello', 'document');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.options).toBeDefined();
    expect(body.options.num_ctx).toBe(8192);
  });

  it('with OLLAMA_NUM_CTX=4096: body contains options.num_ctx of 4096', async () => {
    fetchMock.mockResolvedValueOnce(ok([0.1, 0.2, 0.3]));
    // Constructor arg numCtx=4096 (as factory would pass from env)
    const e = new OllamaEmbedder('http://localhost:11434', 'nomic-embed-text', undefined, 4096);
    await e.embed('hello', 'document');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.options.num_ctx).toBe(4096);
  });

  it('factory: OLLAMA_NUM_CTX=4096 passes through to embedder', async () => {
    vi.stubEnv('EMBEDDING_PROVIDER', 'ollama');
    vi.stubEnv('OLLAMA_NUM_CTX', '4096');
    // Import factory dynamically so env stubs are in effect
    const { createEmbedder } = await import('../../src/embeddings/factory.js');
    fetchMock.mockResolvedValueOnce(ok([0.1, 0.2, 0.3]));
    const e = createEmbedder();
    await e.embed('test', 'document');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.options.num_ctx).toBe(4096);
  });

  it('factory: OLLAMA_NUM_CTX empty string → default 8192', async () => {
    vi.stubEnv('EMBEDDING_PROVIDER', 'ollama');
    vi.stubEnv('OLLAMA_NUM_CTX', '');
    const { createEmbedder } = await import('../../src/embeddings/factory.js');
    fetchMock.mockResolvedValueOnce(ok([0.1, 0.2, 0.3]));
    const e = createEmbedder();
    await e.embed('test', 'document');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.options.num_ctx).toBe(8192);
  });

  it('factory: OLLAMA_NUM_CTX=banana (invalid) → default 8192, no throw', async () => {
    vi.stubEnv('EMBEDDING_PROVIDER', 'ollama');
    vi.stubEnv('OLLAMA_NUM_CTX', 'banana');
    const { createEmbedder } = await import('../../src/embeddings/factory.js');
    fetchMock.mockResolvedValueOnce(ok([0.1, 0.2, 0.3]));
    let e: Awaited<ReturnType<typeof createEmbedder>>;
    expect(() => { e = createEmbedder(); }).not.toThrow();
    await e!.embed('test', 'document');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.options.num_ctx).toBe(8192);
  });
});
