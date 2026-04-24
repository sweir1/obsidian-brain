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

function fail(status: number, statusText: string, body = ''): Response {
  return {
    ok: false,
    status,
    statusText,
    json: async () => ({}),
    text: async () => body,
  } as unknown as Response;
}

describe('OllamaEmbedder', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    fetchMock = vi.fn();
    originalFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('nomic-embed-text: prepends "search_document: " for document task type', async () => {
    fetchMock.mockResolvedValueOnce(ok([0.1, 0.2, 0.3]));
    const e = new OllamaEmbedder('http://localhost:11434', 'nomic-embed-text');
    await e.embed('the quick brown fox', 'document');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:11434/api/embeddings');
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe('nomic-embed-text');
    expect(body.prompt).toBe('search_document: the quick brown fox');
  });

  it('nomic-embed-text: prepends "search_query: " for query task type', async () => {
    fetchMock.mockResolvedValueOnce(ok([0.1, 0.2, 0.3]));
    const e = new OllamaEmbedder('http://localhost:11434', 'nomic-embed-text');
    await e.embed('what is the meaning of life', 'query');
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.prompt).toBe('search_query: what is the meaning of life');
  });

  it('qwen3-embedding: prepends "Query: " only on query task type', async () => {
    fetchMock.mockResolvedValueOnce(ok([0.1])).mockResolvedValueOnce(ok([0.1]));
    const e = new OllamaEmbedder('http://localhost:11434', 'qwen3-embedding-8b');
    await e.embed('a doc', 'document');
    await e.embed('a question', 'query');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).prompt).toBe('a doc');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).prompt).toBe('Query: a question');
  });

  // ── E5 family prefix tests ─────────────────────────────────────────────────

  it('multilingual-e5-small: prepends "query: " on query task type', async () => {
    fetchMock.mockResolvedValueOnce(ok([0.1]));
    const e = new OllamaEmbedder('http://localhost:11434', 'multilingual-e5-small');
    await e.embed('what is life', 'query');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).prompt).toBe('query: what is life');
  });

  it('multilingual-e5-small: prepends "passage: " on document task type', async () => {
    fetchMock.mockResolvedValueOnce(ok([0.1]));
    const e = new OllamaEmbedder('http://localhost:11434', 'multilingual-e5-small');
    await e.embed('some document text', 'document');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).prompt).toBe('passage: some document text');
  });

  it('multilingual-e5-large: prepends "query: " on query task type', async () => {
    fetchMock.mockResolvedValueOnce(ok([0.1]));
    const e = new OllamaEmbedder('http://localhost:11434', 'multilingual-e5-large');
    await e.embed('search this', 'query');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).prompt).toBe('query: search this');
  });

  it('multilingual-e5-large: prepends "passage: " on document task type', async () => {
    fetchMock.mockResolvedValueOnce(ok([0.1]));
    const e = new OllamaEmbedder('http://localhost:11434', 'multilingual-e5-large');
    await e.embed('document body', 'document');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).prompt).toBe('passage: document body');
  });

  // ── bge-m3: INTENTIONALLY no-prefix (FlagEmbedding research) ──────────────

  it('bge-m3: no prefix on query (intentional per FlagEmbedding docs)', async () => {
    fetchMock.mockResolvedValueOnce(ok([0.1]));
    const e = new OllamaEmbedder('http://localhost:11434', 'bge-m3');
    await e.embed('a query', 'query');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).prompt).toBe('a query');
  });

  it('bge-m3: no prefix on document (intentional per FlagEmbedding docs)', async () => {
    fetchMock.mockResolvedValueOnce(ok([0.1]));
    const e = new OllamaEmbedder('http://localhost:11434', 'bge-m3');
    await e.embed('some document', 'document');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).prompt).toBe('some document');
  });

  it('mxbai-embed-large: prepends retrieval preamble only on query', async () => {
    fetchMock.mockResolvedValueOnce(ok([0.1])).mockResolvedValueOnce(ok([0.1]));
    const e = new OllamaEmbedder('http://localhost:11434', 'mxbai-embed-large');
    await e.embed('doc content', 'document');
    await e.embed('my query', 'query');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).prompt).toBe('doc content');
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).prompt).toBe(
      'Represent this sentence for searching relevant passages: my query',
    );
  });

  it('mixedbread model name also triggers mxbai-style prefix', async () => {
    fetchMock.mockResolvedValueOnce(ok([0.1]));
    const e = new OllamaEmbedder('http://localhost:11434', 'mixedbread-ai/mxbai-embed-large-v1');
    await e.embed('q', 'query');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).prompt).toBe(
      'Represent this sentence for searching relevant passages: q',
    );
  });

  it('unknown model gets raw text, no prefix', async () => {
    fetchMock.mockResolvedValueOnce(ok([0.1]));
    const e = new OllamaEmbedder('http://localhost:11434', 'some-custom-model');
    await e.embed('hello', 'query');
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).prompt).toBe('hello');
  });

  it('dimensions() throws before any embed() call', () => {
    const e = new OllamaEmbedder();
    expect(() => e.dimensions()).toThrow(/dimensions not known yet/i);
  });

  it('dimensions() returns vector length after first embed()', async () => {
    fetchMock.mockResolvedValueOnce(ok(new Array(768).fill(0.001)));
    const e = new OllamaEmbedder();
    const vec = await e.embed('anything');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(vec.length).toBe(768);
    expect(e.dimensions()).toBe(768);
  });

  it('dimensions() is callable immediately when expectedDim is provided', () => {
    const e = new OllamaEmbedder('http://localhost:11434', 'nomic-embed-text', 768);
    expect(e.dimensions()).toBe(768);
  });

  it('subsequent embed() with mismatched dim throws a clear error', async () => {
    fetchMock
      .mockResolvedValueOnce(ok(new Array(768).fill(0.0))) // sets cachedDim=768
      .mockResolvedValueOnce(ok(new Array(1024).fill(0.0))); // then drift
    const e = new OllamaEmbedder();
    await e.embed('first');
    await expect(e.embed('second')).rejects.toThrow(/Ollama dim mismatch/);
  });

  it('surfaces HTTP error with clear guidance', async () => {
    fetchMock.mockResolvedValueOnce(fail(404, 'Not Found', 'model not found'));
    const e = new OllamaEmbedder('http://localhost:11434', 'nomic-embed-text');
    await expect(e.embed('x')).rejects.toThrow(
      /Ollama embed failed: HTTP 404.*ollama pull nomic-embed-text/s,
    );
  });

  it('surfaces empty-embedding response with a hint', async () => {
    fetchMock.mockResolvedValueOnce(ok([]));
    const e = new OllamaEmbedder('http://localhost:11434', 'some-chat-model');
    await expect(e.embed('x')).rejects.toThrow(/empty vector/);
  });

  it('modelIdentifier + providerName include the backend name', () => {
    const e = new OllamaEmbedder('http://localhost:11434', 'nomic-embed-text');
    expect(e.modelIdentifier()).toBe('ollama:nomic-embed-text');
    expect(e.providerName()).toBe('ollama');
  });

  it('init() probes once when no dim was supplied', async () => {
    fetchMock.mockResolvedValueOnce(ok(new Array(384).fill(0)));
    const e = new OllamaEmbedder();
    await e.init();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(e.dimensions()).toBe(384);
  });

  it('init() is a no-op when expectedDim was supplied', async () => {
    const e = new OllamaEmbedder('http://localhost:11434', 'nomic-embed-text', 768);
    await e.init();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(e.dimensions()).toBe(768);
  });
});
