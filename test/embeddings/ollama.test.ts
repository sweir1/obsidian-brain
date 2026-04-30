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

  // O1/O9 (v1.7.19): when init() / embed() failed earlier (Ollama daemon
  // down, model not pulled, etc.), `dimensions()` rethrows the actionable
  // error instead of the generic "dim not known" shim.
  it('dimensions() rethrows captured embed() error after a failed call', async () => {
    fetchMock.mockResolvedValueOnce(fail(404, 'Not Found', 'model not found'));
    const e = new OllamaEmbedder('http://localhost:11434', 'qwen3-embedding:0.6b');
    await expect(e.embed('x')).rejects.toThrow(/HTTP 404/);
    // The next direct dimensions() call should rethrow that 404, not the
    // generic shim message.
    expect(() => e.dimensions()).toThrow(/HTTP 404.*ollama pull qwen3-embedding:0.6b/s);
    expect(() => e.dimensions()).not.toThrow(/dimensions not known yet/);
  });

  it('dimensions() rethrows captured init() error after a failed init', async () => {
    // /api/show fails (404), /api/tags fails (404), legacy embed probe also 404s.
    fetchMock
      .mockResolvedValueOnce(fail(404, 'Not Found'))
      .mockResolvedValueOnce(fail(404, 'Not Found'))
      .mockResolvedValueOnce(fail(404, 'Not Found', 'model not found'));
    const e = new OllamaEmbedder('http://localhost:11434', 'qwen3-embedding:0.6b');
    await expect(e.init()).rejects.toThrow(/HTTP 404/);
    expect(() => e.dimensions()).toThrow(/HTTP 404.*ollama pull qwen3-embedding:0.6b/s);
  });

  it('dimensions() falls back to generic message when no error has been captured', () => {
    const e = new OllamaEmbedder();
    expect(() => e.dimensions()).toThrow(/dimensions not known yet/i);
  });

  // v1.7.20 Fix 9 (O5): the workaround hint about OLLAMA_EMBEDDING_DIM
  // is gone — v1.7.19's `dimensions()` rethrow makes the underlying init
  // error reach the user, so directing them to a workaround env var is
  // misleading. The generic message is reserved for a now-impossible state.
  it('Fix 9: generic dimensions() error no longer mentions the obsolete OLLAMA_EMBEDDING_DIM workaround', () => {
    const e = new OllamaEmbedder();
    expect(() => e.dimensions()).toThrow(/dimensions not known yet/i);
    expect(() => e.dimensions()).not.toThrow(/OLLAMA_EMBEDDING_DIM/);
    expect(() => e.dimensions()).not.toThrow(/pass.*OLLAMA/);
  });

  it('lastError clears on a successful retry', async () => {
    fetchMock
      .mockResolvedValueOnce(fail(404, 'Not Found', 'first attempt')) // embed call A
      .mockResolvedValueOnce(ok(new Array(384).fill(0.001))); // embed call B
    const e = new OllamaEmbedder();
    await expect(e.embed('first')).rejects.toThrow(/HTTP 404/);
    expect(() => e.dimensions()).toThrow(/HTTP 404/);
    // Successful retry — lastError clears, dim becomes known, dimensions() returns.
    await e.embed('second');
    expect(e.dimensions()).toBe(384);
  });

  it('modelIdentifier + providerName include the backend name', () => {
    const e = new OllamaEmbedder('http://localhost:11434', 'nomic-embed-text');
    expect(e.modelIdentifier()).toBe('ollama:nomic-embed-text');
    expect(e.providerName()).toBe('ollama');
  });

  // v1.7.20 Fix 1b: when setMetadata is called with a fallback-attributed
  // row (e.g. probe-fallback wrote nulls because seed lookup missed), the
  // embedder should fall through to the hardcoded family heuristic at
  // embed time. Without this, BYOM Ollama users with asymmetric models
  // (qwen-*, e5-*, mxbai-*) silently get empty prefixes.

  it('Fix 1b: setMetadata with prefixSource=fallback falls through to getPrefix() heuristic', async () => {
    fetchMock.mockResolvedValueOnce(ok(new Array(1024).fill(0.001)));
    const e = new OllamaEmbedder('http://localhost:11434', 'qwen3-embedding:0.6b');
    e.setMetadata({
      modelId: 'ollama:qwen3-embedding:0.6b',
      dim: 1024,
      maxTokens: 512,
      queryPrefix: '', // fallback row — empty
      documentPrefix: '',
      prefixSource: 'fallback',
      baseModel: null,
      sizeBytes: null,
    });
    await e.embed('butter chicken', 'query');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    // qwen-family heuristic kicks in because prefixSource is 'fallback'.
    expect(body.prompt).toBe('Query: butter chicken');
  });

  it('Fix 1b: setMetadata with authoritative prefixSource=seed wins even when prefix is empty', async () => {
    fetchMock.mockResolvedValueOnce(ok(new Array(384).fill(0.001)));
    const e = new OllamaEmbedder('http://localhost:11434', 'bge-m3');
    e.setMetadata({
      modelId: 'ollama:bge-m3',
      dim: 1024,
      maxTokens: 8192,
      queryPrefix: '', // bge-m3 is symmetric — empty is correct
      documentPrefix: '',
      prefixSource: 'seed',
      baseModel: null,
      sizeBytes: null,
    });
    await e.embed('test', 'query');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    // Authoritative empty wins; getPrefix() heuristic NOT applied.
    expect(body.prompt).toBe('test');
  });

  it('Fix 1b: prefixSource=override with cleared prefix wins (user explicitly cleared)', async () => {
    fetchMock.mockResolvedValueOnce(ok(new Array(384).fill(0.001)));
    const e = new OllamaEmbedder('http://localhost:11434', 'qwen3-embedding:0.6b');
    e.setMetadata({
      modelId: 'ollama:qwen3-embedding:0.6b',
      dim: 1024,
      maxTokens: 512,
      queryPrefix: '', // user override cleared it
      documentPrefix: '',
      prefixSource: 'override',
      baseModel: null,
      sizeBytes: null,
    });
    await e.embed('test', 'query');
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    // User's explicit clear wins; getPrefix() NOT applied.
    expect(body.prompt).toBe('test');
  });

  // ---------------------------------------------------------------------
  // Init flow — verified live against `nomic-embed-text` running on a
  // local Ollama 0.x: two best-effort HTTP calls (`/api/show` for the
  // dim + context_length + capabilities, `/api/tags` for the manifest
  // digest) instead of the legacy test-embedding probe. Capability check
  // fails fast on non-embedding models. Real-world response was:
  //   model_info["nomic-bert.embedding_length"] = 768  → dim
  //   model_info["nomic-bert.context_length"]   = 2048 → max-tokens
  //   capabilities = ["embedding"]
  //   /api/tags → digest = "0a109f422b47e..."
  // The tests below cover happy path + every fallback / failure mode.
  //
  // Mock dims throughout are arbitrary (kept tiny — `[0.1]` style — when
  // the actual value doesn't matter to the assertion, or pinned to a
  // realistic 768 only when the test is documenting the dim-extraction
  // path). They are NOT real Ollama model dims; the ones that ARE real
  // come from the `/api/show` mock response, not the embed mock.
  // ---------------------------------------------------------------------

  /** Helper: fake `/api/show` response with a given embedding_length and
   *  context_length under a `<arch>.X` key. */
  function showResponse(
    arch: string,
    embeddingLength: number,
    contextLength: number,
    capabilities: string[] = ['embedding'],
  ): Response {
    return {
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({
        capabilities,
        model_info: {
          [`${arch}.embedding_length`]: embeddingLength,
          [`${arch}.context_length`]: contextLength,
        },
      }),
      text: async () => '',
    } as unknown as Response;
  }

  /** Helper: fake `/api/tags` response listing one model with a digest. */
  function tagsResponse(name: string, digest: string): Response {
    return {
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ models: [{ name, digest }] }),
      text: async () => '',
    } as unknown as Response;
  }

  it('init() reads dim, context_length, and digest from /api/show + /api/tags (no test embed fired)', async () => {
    // Mirrors the live nomic-embed-text response shape.
    fetchMock.mockResolvedValueOnce(showResponse('nomic-bert', 768, 2048));
    fetchMock.mockResolvedValueOnce(tagsResponse('nomic-embed-text:latest', 'sha256:abc'));
    const e = new OllamaEmbedder('http://localhost:11434', 'nomic-embed-text');
    await e.init();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:11434/api/show');
    expect(fetchMock.mock.calls[1][0]).toBe('http://localhost:11434/api/tags');
    expect(e.dimensions()).toBe(768);
    expect(e.identityHash()).toBe('sha256:abc');
    expect(e.getContextLength()).toBe(2048);
  });

  it('init() falls back to a test-embedding probe when /api/show lacks embedding_length', async () => {
    // /api/show returns capabilities but no model_info — older Ollama
    // versions or unusual architectures. Fall through to legacy probe.
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ capabilities: ['embedding'] }),
      text: async () => '',
    } as unknown as Response);
    fetchMock.mockResolvedValueOnce(tagsResponse('foo:latest', 'sha256:fb'));
    const probeDim = 7; // arbitrary mock dim — small to make the fallback path obvious
    fetchMock.mockResolvedValueOnce(ok(new Array(probeDim).fill(0)));
    const e = new OllamaEmbedder('http://localhost:11434', 'foo');
    await e.init();
    expect(e.dimensions()).toBe(probeDim);
    expect(e.getContextLength()).toBeNull();
  });

  it('init() rejects models that do NOT advertise the embedding capability', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ capabilities: ['completion', 'tools'] }),
      text: async () => '',
    } as unknown as Response);
    const e = new OllamaEmbedder('http://localhost:11434', 'some-llm');
    await expect(e.init()).rejects.toThrow(/not "embedding"/);
  });

  it('init() makes /api/show + /api/tags but skips the embed probe when expectedDim was supplied', async () => {
    fetchMock.mockResolvedValueOnce(showResponse('nomic-bert', 768, 2048));
    fetchMock.mockResolvedValueOnce(tagsResponse('nomic-embed-text:latest', 'sha256:def'));
    const e = new OllamaEmbedder('http://localhost:11434', 'nomic-embed-text', 768);
    await e.init();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(e.dimensions()).toBe(768);
    expect(e.identityHash()).toBe('sha256:def');
  });

  it('identityHash() returns null when /api/tags is unreachable (graceful)', async () => {
    fetchMock.mockResolvedValueOnce(showResponse('nomic-bert', 768, 2048));
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const e = new OllamaEmbedder('http://localhost:11434', 'nomic-embed-text');
    await e.init();
    expect(e.dimensions()).toBe(768);
    expect(e.identityHash()).toBeNull();
  });

  it('identityHash() returns null when the active model is missing from /api/tags', async () => {
    fetchMock.mockResolvedValueOnce(showResponse('nomic-bert', 768, 2048));
    fetchMock.mockResolvedValueOnce(tagsResponse('some-other-model:latest', 'sha256:xyz'));
    const e = new OllamaEmbedder('http://localhost:11434', 'nomic-embed-text');
    await e.init();
    expect(e.identityHash()).toBeNull();
  });

  it('identityHash() matches the bare-name model against `name:latest` in /api/tags', async () => {
    // User passes `bge-m3`; Ollama's /api/tags returns `bge-m3:latest`.
    // The embedder should match these as the same.
    fetchMock.mockResolvedValueOnce(showResponse('bert', 1024, 8194));
    fetchMock.mockResolvedValueOnce(tagsResponse('bge-m3:latest', 'sha256:567ca40'));
    const e = new OllamaEmbedder('http://localhost:11434', 'bge-m3');
    await e.init();
    expect(e.identityHash()).toBe('sha256:567ca40');
  });

  // ---------------------------------------------------------------------
  // v1.7.21 Fix 2 — auto `ollama pull` on missing model. Default ON;
  // opt-out via OBSIDIAN_BRAIN_OLLAMA_AUTO_PULL=0.
  //
  // /api/pull returns NDJSON (one JSON object per line):
  //   {"status":"pulling manifest"}
  //   {"status":"downloading","digest":"sha256:...","total":N,"completed":M}
  //   {"status":"success"}
  // (or {"error":"…"} on failure)
  // ---------------------------------------------------------------------

  /** Fake `/api/show` 404 — model not pulled. */
  function showNotPulled(): Response {
    return {
      ok: false, status: 404, statusText: 'Not Found',
      json: async () => ({ error: `model "test" not found, try pulling it first` }),
      text: async () => '',
    } as unknown as Response;
  }

  /** Fake `/api/tags` empty (model not in tags list). */
  function tagsEmpty(): Response {
    return {
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ models: [] }),
      text: async () => '',
    } as unknown as Response;
  }

  /** Fake `/api/pull` streaming-success response. Builds a mock Response
   *  with a ReadableStream body that emits the given NDJSON lines. */
  function pullSuccessResponse(lines: string[]): Response {
    const encoder = new TextEncoder();
    const body = new ReadableStream({
      start(controller) {
        for (const line of lines) controller.enqueue(encoder.encode(line + '\n'));
        controller.close();
      },
    });
    return {
      ok: true, status: 200, statusText: 'OK',
      body,
      json: async () => ({}),
      text: async () => '',
    } as unknown as Response;
  }

  it('Fix 2: /api/show 404 → auto-pull → re-probe → embedder ready (default ON)', async () => {
    // 1st call: /api/show → 404 (model not pulled)
    fetchMock.mockResolvedValueOnce(showNotPulled());
    // 2nd call: /api/tags → empty
    fetchMock.mockResolvedValueOnce(tagsEmpty());
    // 3rd call: /api/pull → streaming success
    fetchMock.mockResolvedValueOnce(
      pullSuccessResponse([
        '{"status":"pulling manifest"}',
        '{"status":"downloading","digest":"sha256:abc","total":1000000,"completed":500000}',
        '{"status":"downloading","digest":"sha256:abc","total":1000000,"completed":1000000}',
        '{"status":"success"}',
      ]),
    );
    // 4th call: /api/show retry → success
    fetchMock.mockResolvedValueOnce(showResponse('qwen3', 1024, 32768));
    // 5th call: /api/tags retry → digest now present
    fetchMock.mockResolvedValueOnce(tagsResponse('qwen3-embedding:0.6b', 'sha256:def'));

    const prevAutoPull = process.env.OBSIDIAN_BRAIN_OLLAMA_AUTO_PULL;
    delete process.env.OBSIDIAN_BRAIN_OLLAMA_AUTO_PULL;
    try {
      const e = new OllamaEmbedder('http://localhost:11434', 'qwen3-embedding:0.6b');
      await e.init();
      expect(e.dimensions()).toBe(1024);
      expect(e.getContextLength()).toBe(32768);
      expect(e.identityHash()).toBe('sha256:def');
      // Verify /api/pull was called.
      const pullCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/api/pull'));
      expect(pullCall).toBeDefined();
      const pullBody = JSON.parse((pullCall![1] as RequestInit).body as string);
      expect(pullBody.model).toBe('qwen3-embedding:0.6b');
      expect(pullBody.stream).toBe(true);
    } finally {
      if (prevAutoPull !== undefined) process.env.OBSIDIAN_BRAIN_OLLAMA_AUTO_PULL = prevAutoPull;
    }
  });

  it('Fix 2: /api/pull returning {"error":"..."} → init() throws actionable message; dimensions() rethrows', async () => {
    fetchMock.mockResolvedValueOnce(showNotPulled());
    fetchMock.mockResolvedValueOnce(tagsEmpty());
    fetchMock.mockResolvedValueOnce(
      pullSuccessResponse([
        '{"status":"pulling manifest"}',
        '{"error":"file does not exist"}',
      ]),
    );
    const prevAutoPull = process.env.OBSIDIAN_BRAIN_OLLAMA_AUTO_PULL;
    delete process.env.OBSIDIAN_BRAIN_OLLAMA_AUTO_PULL;
    try {
      const e = new OllamaEmbedder('http://localhost:11434', 'bogus-model');
      await expect(e.init()).rejects.toThrow(/Ollama auto-pull failed.*file does not exist.*OBSIDIAN_BRAIN_OLLAMA_AUTO_PULL=0/s);
      // v1.7.19 lastError plumbing — dimensions() rethrows the same error.
      expect(() => e.dimensions()).toThrow(/Ollama auto-pull failed/);
    } finally {
      if (prevAutoPull !== undefined) process.env.OBSIDIAN_BRAIN_OLLAMA_AUTO_PULL = prevAutoPull;
    }
  });

  it('Fix 2: OBSIDIAN_BRAIN_OLLAMA_AUTO_PULL=0 → no /api/pull, falls through to v1.7.20 actionable error', async () => {
    fetchMock.mockResolvedValueOnce(showNotPulled());
    fetchMock.mockResolvedValueOnce(tagsEmpty());
    // 3rd call: legacy embed probe fires (because cachedDim still undefined
    // and auto-pull is disabled). Mock it to fail with the standard 404.
    fetchMock.mockResolvedValueOnce(fail(404, 'Not Found', 'model not found'));
    const prevAutoPull = process.env.OBSIDIAN_BRAIN_OLLAMA_AUTO_PULL;
    process.env.OBSIDIAN_BRAIN_OLLAMA_AUTO_PULL = '0';
    try {
      const e = new OllamaEmbedder('http://localhost:11434', 'qwen3-embedding:0.6b');
      await expect(e.init()).rejects.toThrow(/HTTP 404.*ollama pull qwen3-embedding:0.6b/s);
      // No /api/pull was called.
      const pullCall = fetchMock.mock.calls.find((c) => String(c[0]).endsWith('/api/pull'));
      expect(pullCall).toBeUndefined();
    } finally {
      if (prevAutoPull !== undefined) {
        process.env.OBSIDIAN_BRAIN_OLLAMA_AUTO_PULL = prevAutoPull;
      } else {
        delete process.env.OBSIDIAN_BRAIN_OLLAMA_AUTO_PULL;
      }
    }
  });
});
