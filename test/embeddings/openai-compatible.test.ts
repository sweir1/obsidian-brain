import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  OpenAICompatibleEmbedder,
  normalizeBaseUrl,
  coerceVector,
  l2Normalize,
  DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
} from '../../src/embeddings/openai-compatible.js';
import type { EmbedderMetadata } from '../../src/embeddings/types.js';

const BASE = 'http://127.0.0.1:8082';

/** A unit vector of length `dim`, so the defensive normaliser is a no-op and
 *  assertions can compare returned values against what was sent. */
function unitVector(dim: number): number[] {
  const v = new Array<number>(dim).fill(0);
  v[0] = 1;
  return v;
}

function embeddingsResponse(embedding: unknown): Response {
  return new Response(
    JSON.stringify({ object: 'list', model: 'test', data: [{ index: 0, embedding }] }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

/** llama.cpp `/props`, trimmed to the fields we actually read. */
function propsResponse(nCtx: number | null, modelPath = '/m/qwen.gguf', build = 'b10673'): Response {
  const body: Record<string, unknown> = { model_path: modelPath, build_info: build };
  if (nCtx !== null) body.default_generation_settings = { n_ctx: nCtx };
  return new Response(JSON.stringify(body), { status: 200 });
}

/**
 * Route fetch by URL so each test declares only what it cares about.
 * Unstubbed routes return 404 — the same thing a real server does for a route
 * it doesn't implement, which is precisely the llama.cpp-vs-Ollama case.
 */
function stubFetch(routes: {
  props?: () => Response | Promise<Response>;
  embeddings?: (body: { model?: string; input?: string }) => Response | Promise<Response>;
}) {
  const spy = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/props')) {
      return routes.props ? routes.props() : new Response('', { status: 404 });
    }
    if (u.endsWith('/v1/embeddings')) {
      if (!routes.embeddings) return new Response('', { status: 404 });
      return routes.embeddings(JSON.parse(String(init?.body ?? '{}')));
    }
    return new Response('', { status: 404 });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('normalizeBaseUrl', () => {
  it.each([
    ['http://localhost:8080', 'http://localhost:8080'],
    ['http://localhost:8080/', 'http://localhost:8080'],
    ['http://localhost:8080///', 'http://localhost:8080'],
    // Users copy `.../v1` out of OpenAI client docs; appending our own /v1
    // would silently produce /v1/v1/embeddings → a 404 that reads like the
    // server is broken rather than like a config typo.
    ['http://localhost:8080/v1', 'http://localhost:8080'],
    ['http://localhost:8080/v1/', 'http://localhost:8080'],
    ['http://localhost:8080/V1', 'http://localhost:8080'],
    ['  http://localhost:8080  ', 'http://localhost:8080'],
    // A genuine sub-path (reverse proxy) must survive untouched.
    ['https://gw.example.com/embed', 'https://gw.example.com/embed'],
  ])('normalizes %s → %s', (input, expected) => {
    expect(normalizeBaseUrl(input)).toBe(expected);
  });
});

describe('coerceVector', () => {
  it('accepts the flat array /v1/embeddings returns', () => {
    expect(coerceVector([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it('unwraps the nested array llama.cpp’s native /embedding returns', () => {
    expect(coerceVector([[1, 2, 3]])).toEqual([1, 2, 3]);
  });

  it('takes the first row when --pooling none yields one vector per token', () => {
    expect(coerceVector([[1, 2], [3, 4]])).toEqual([1, 2]);
  });

  it.each([
    ['empty array', []],
    ['null', null],
    ['object', { a: 1 }],
    ['string content', ['a', 'b']],
    ['NaN content', [1, NaN, 3]],
    ['Infinity content', [1, Infinity]],
    ['nested with non-numbers', [['a', 'b']]],
  ])('rejects %s', (_label, input) => {
    expect(coerceVector(input)).toBeNull();
  });
});

describe('l2Normalize', () => {
  it('leaves an already-unit vector untouched', () => {
    const out = l2Normalize([1, 0, 0]);
    expect(Array.from(out)).toEqual([1, 0, 0]);
  });

  it('normalizes an unnormalized vector to unit length', () => {
    const out = l2Normalize([3, 4]);
    expect(out[0]).toBeCloseTo(0.6, 6);
    expect(out[1]).toBeCloseTo(0.8, 6);
  });

  it('leaves the zero vector alone instead of dividing by zero', () => {
    const out = l2Normalize([0, 0, 0]);
    expect(Array.from(out)).toEqual([0, 0, 0]);
    expect(Array.from(out).every((x) => Number.isFinite(x))).toBe(true);
  });
});

describe('OpenAICompatibleEmbedder', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('defaults to llama-server’s port and reports the protocol as its provider', () => {
    const e = new OpenAICompatibleEmbedder();
    expect(e.baseUrl).toBe(DEFAULT_OPENAI_COMPATIBLE_BASE_URL);
    expect(e.providerName()).toBe('openai-compatible');
  });

  it('prefixes modelIdentifier with the protocol, not the vendor', () => {
    const e = new OpenAICompatibleEmbedder(BASE, 'Qwen/Qwen3-Embedding-0.6B');
    expect(e.modelIdentifier()).toBe('openai:Qwen/Qwen3-Embedding-0.6B');
  });

  it('starts in the not-started phase', () => {
    expect(new OpenAICompatibleEmbedder(BASE).phase).toEqual({ status: 'not-started' });
  });

  describe('init()', () => {
    it('probes dim with one embed and caches n_ctx + identity from /props', async () => {
      const spy = stubFetch({
        props: () => propsResponse(8192, '/m/qwen.gguf', 'b10673'),
        embeddings: () => embeddingsResponse(unitVector(1024)),
      });
      const e = new OpenAICompatibleEmbedder(BASE, 'Qwen/Qwen3-Embedding-0.6B');
      await e.init();

      expect(e.dimensions()).toBe(1024);
      expect(e.getContextLength()).toBe(8192);
      expect(e.identityHash()).toBe('/m/qwen.gguf@b10673');
      expect(e.phase).toEqual({ status: 'ready' });
      // Exactly one probe embed — init must not be expensive.
      const embedCalls = spy.mock.calls.filter((c) => String(c[0]).endsWith('/v1/embeddings'));
      expect(embedCalls).toHaveLength(1);
    });

    it('skips the probe embed entirely when the dim was declared up front', async () => {
      const spy = stubFetch({ props: () => propsResponse(8192) });
      const e = new OpenAICompatibleEmbedder(BASE, 'm', 1024);
      await e.init();

      expect(e.dimensions()).toBe(1024);
      expect(spy.mock.calls.filter((c) => String(c[0]).endsWith('/v1/embeddings'))).toHaveLength(0);
    });

    it('still succeeds when the server has no /props (not llama.cpp)', async () => {
      stubFetch({ embeddings: () => embeddingsResponse(unitVector(768)) });
      const e = new OpenAICompatibleEmbedder(BASE, 'm');
      await e.init();

      expect(e.dimensions()).toBe(768);
      // Null, not an error — the caller falls back to its own defaults.
      expect(e.getContextLength()).toBeNull();
      expect(e.identityHash()).toBeNull();
      expect(e.phase).toEqual({ status: 'ready' });
    });

    it('tolerates /props without n_ctx but still fingerprints the weights', async () => {
      stubFetch({
        props: () => propsResponse(null, '/m/a.gguf', 'b1'),
        embeddings: () => embeddingsResponse(unitVector(64)),
      });
      const e = new OpenAICompatibleEmbedder(BASE, 'm');
      await e.init();

      expect(e.getContextLength()).toBeNull();
      expect(e.identityHash()).toBe('/m/a.gguf@b1');
    });

    it('records the failure in phase and rethrows when the server is unreachable', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => {
          throw new TypeError('fetch failed');
        }),
      );
      const e = new OpenAICompatibleEmbedder(BASE, 'm');
      await expect(e.init()).rejects.toThrow(/Cannot reach .*127\.0\.0\.1:8082/);

      const phase = e.phase;
      expect(phase.status).toBe('failed');
      // The actionable next step must be IN the message — this is the error a
      // user hits most often, and "fetch failed" alone tells them nothing.
      if (phase.status === 'failed') {
        expect(phase.error.message).toMatch(/llama-server .*--embedding/);
        expect(phase.error.message).toContain('--port 8082');
      }
    });
  });

  describe('embed()', () => {
    it('sends the configured model and returns a Float32Array', async () => {
      const spy = stubFetch({ embeddings: () => embeddingsResponse(unitVector(4)) });
      const e = new OpenAICompatibleEmbedder(BASE, 'my-model', 4);
      const vec = await e.embed('hola');

      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec).toHaveLength(4);
      const body = JSON.parse(String(spy.mock.calls[0][1]?.body));
      expect(body.model).toBe('my-model');
      expect(body.input).toBe('hola');
    });

    it('normalizes a vector the server returned unnormalized', async () => {
      stubFetch({ embeddings: () => embeddingsResponse([3, 4]) });
      const e = new OpenAICompatibleEmbedder(BASE, 'm', 2);
      const vec = await e.embed('x');

      // The whole search path compares with a plain dot product, so a
      // non-unit vector would silently skew every similarity score.
      const norm = Math.sqrt(vec[0] ** 2 + vec[1] ** 2);
      expect(norm).toBeCloseTo(1, 5);
    });

    it('sends no Authorization header unless an API key was supplied', async () => {
      const spy = stubFetch({ embeddings: () => embeddingsResponse(unitVector(2)) });
      await new OpenAICompatibleEmbedder(BASE, 'm', 2).embed('x');
      const headers = spy.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    });

    it('sends a Bearer token when an API key was supplied', async () => {
      const spy = stubFetch({ embeddings: () => embeddingsResponse(unitVector(2)) });
      await new OpenAICompatibleEmbedder(BASE, 'm', 2, 'sk-secret').embed('x');
      const headers = spy.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer sk-secret');
    });

    it('treats a blank API key as absent', async () => {
      const spy = stubFetch({ embeddings: () => embeddingsResponse(unitVector(2)) });
      await new OpenAICompatibleEmbedder(BASE, 'm', 2, '   ').embed('x');
      const headers = spy.mock.calls[0][1]?.headers as Record<string, string>;
      expect(headers.Authorization).toBeUndefined();
    });

    it('explains the --embedding flag on HTTP 404', async () => {
      stubFetch({ embeddings: () => new Response('not found', { status: 404 }) });
      const e = new OpenAICompatibleEmbedder(BASE, 'm', 2);
      await expect(e.embed('x')).rejects.toThrow(/--embedding flag/);
    });

    it('points at EMBEDDING_API_KEY on HTTP 401', async () => {
      stubFetch({ embeddings: () => new Response('unauthorized', { status: 401 }) });
      const e = new OpenAICompatibleEmbedder(BASE, 'm', 2);
      await expect(e.embed('x')).rejects.toThrow(/EMBEDDING_API_KEY/);
    });

    it('surfaces an OpenAI-shaped error body', async () => {
      stubFetch({
        embeddings: () =>
          new Response(JSON.stringify({ error: { message: 'model not loaded' } }), { status: 200 }),
      });
      const e = new OpenAICompatibleEmbedder(BASE, 'm', 2);
      await expect(e.embed('x')).rejects.toThrow(/model not loaded/);
    });

    it('rejects an empty vector with a chat-model hint', async () => {
      stubFetch({ embeddings: () => embeddingsResponse([]) });
      const e = new OpenAICompatibleEmbedder(BASE, 'm');
      await expect(e.embed('x')).rejects.toThrow(/embedding model/i);
    });

    it('throws on a dim change rather than corrupting the index', async () => {
      // The realistic trigger: the user restarts llama-server with a
      // different GGUF while obsidian-brain keeps running.
      stubFetch({ embeddings: () => embeddingsResponse(unitVector(512)) });
      const e = new OpenAICompatibleEmbedder(BASE, 'm', 1024);
      await expect(e.embed('x')).rejects.toThrow(/dim mismatch.*expected 1024.*returned 512/s);
    });

    it('keeps the last error retrievable through dimensions()', async () => {
      stubFetch({ embeddings: () => new Response('boom', { status: 500 }) });
      const e = new OpenAICompatibleEmbedder(BASE, 'm');
      await expect(e.embed('x')).rejects.toThrow();
      // index_status reads dimensions() without going through init(); it must
      // see the real cause, not "dim not known yet".
      expect(() => e.dimensions()).toThrow(/HTTP 500/);
    });
  });

  describe('task prefixes', () => {
    async function capturedInput(
      model: string,
      taskType: 'document' | 'query',
      meta?: EmbedderMetadata,
    ): Promise<string> {
      const spy = stubFetch({ embeddings: () => embeddingsResponse(unitVector(2)) });
      const e = new OpenAICompatibleEmbedder(BASE, model, 2);
      if (meta) e.setMetadata(meta);
      await e.embed('TEXT', taskType);
      return JSON.parse(String(spy.mock.calls[0][1]?.body)).input;
    }

    function meta(over: Partial<EmbedderMetadata>): EmbedderMetadata {
      return {
        modelId: 'm',
        dim: 2,
        maxTokens: 512,
        queryPrefix: '',
        documentPrefix: '',
        prefixSource: 'seed',
        baseModel: null,
        sizeBytes: null,
        ...over,
      };
    }

    // The model id here is usually an HF checkpoint id rather than an Ollama
    // tag, so the heuristics must match both spellings.
    it.each([
      ['Qwen/Qwen3-Embedding-0.6B', 'query', 'Query: TEXT'],
      ['Qwen/Qwen3-Embedding-0.6B', 'document', 'TEXT'],
      ['qwen3-embedding:0.6b', 'query', 'Query: TEXT'],
      ['nomic-embed-text', 'query', 'search_query: TEXT'],
      ['nomic-embed-text', 'document', 'search_document: TEXT'],
      ['intfloat/multilingual-e5-small', 'query', 'query: TEXT'],
      ['intfloat/multilingual-e5-small', 'document', 'passage: TEXT'],
      ['BAAI/bge-m3', 'query', 'TEXT'],
    ] as Array<[string, 'document' | 'query', string]>)(
      'falls back to the family heuristic for %s/%s',
      async (model, taskType, expected) => {
        expect(await capturedInput(model, taskType)).toBe(expected);
      },
    );

    it('prefers authoritative seed metadata over the heuristic', async () => {
      // This is the case that makes Qwen3-Embedding work properly: the seed
      // carries the full instruction template, the heuristic only a stand-in.
      const input = await capturedInput(
        'Qwen/Qwen3-Embedding-0.6B',
        'query',
        meta({ queryPrefix: 'Instruct: Given a web search query…\nQuery:', prefixSource: 'seed' }),
      );
      expect(input).toBe('Instruct: Given a web search query…\nQuery:TEXT');
    });

    it('honors an override that deliberately clears the prefix', async () => {
      const input = await capturedInput(
        'Qwen/Qwen3-Embedding-0.6B',
        'query',
        meta({ queryPrefix: '', prefixSource: 'override' }),
      );
      expect(input).toBe('TEXT');
    });

    it.each(['fallback', 'none'] as const)(
      'ignores non-authoritative %s metadata and keeps the heuristic',
      async (prefixSource) => {
        const input = await capturedInput(
          'Qwen/Qwen3-Embedding-0.6B',
          'query',
          meta({ queryPrefix: '', prefixSource }),
        );
        expect(input).toBe('Query: TEXT');
      },
    );

    it('substitutes every {text} placeholder in a template prefix', async () => {
      const input = await capturedInput(
        'm',
        'query',
        meta({ queryPrefix: 'Task: {text}\nQuery: {text}', prefixSource: 'seed' }),
      );
      expect(input).toBe('Task: TEXT\nQuery: TEXT');
    });

    it('round-trips metadata through getMetadata', () => {
      const e = new OpenAICompatibleEmbedder(BASE, 'm', 2);
      expect(e.getMetadata()).toBeNull();
      const m = meta({ queryPrefix: 'Q: ' });
      e.setMetadata(m);
      expect(e.getMetadata()).toEqual(m);
    });
  });

  it('dispose() is a no-op the server owns', async () => {
    await expect(new OpenAICompatibleEmbedder(BASE, 'm', 2).dispose()).resolves.toBeUndefined();
  });
});
