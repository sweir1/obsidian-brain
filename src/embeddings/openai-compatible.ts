import type { Embedder, EmbedderMetadata } from './types.js';
import { DEFAULT_OPENAI_COMPATIBLE_MODEL } from './presets.js';
import { debugLog } from '../util/debug-log.js';

/**
 * Lifecycle states for an `OpenAICompatibleEmbedder`.
 *
 * Deliberately a STRUCTURAL SUBSET of `OllamaPhase` (`src/embeddings/ollama.ts`)
 * minus the `pulling` variant: an OpenAI-compatible server already has its
 * weights loaded before it accepts connections, so there is nothing for us to
 * download and no progress to report. Keeping the shape compatible means
 * `src/tools/preparing.ts` picks this up through its existing duck-typed
 * `.phase` read with no change on that side.
 *
 * State diagram:
 *   not-started → probing → (ready | failed)
 *                 failed  → terminal until the next init() retry
 */
export type OpenAICompatiblePhase =
  | { status: 'not-started' }
  | { status: 'probing' }
  | { status: 'ready' }
  | { status: 'failed'; error: Error };

debugLog('module-load: src/embeddings/openai-compatible.ts');

/** Default endpoint — llama.cpp's `llama-server` listens here out of the box. */
export const DEFAULT_OPENAI_COMPATIBLE_BASE_URL = 'http://localhost:8080';

/**
 * A note on the `model` field, since it behaves unlike every other provider:
 * an OpenAI-compatible embedding server generally serves exactly ONE model and
 * ignores the request's `model` entirely (verified against llama.cpp b10673 —
 * `/v1/embeddings` returns the loaded GGUF whatever `model` says). The string
 * is therefore a LABEL, not a selector. It still matters, because it is the key
 * `metadata-resolver.ts` looks prefixes and max-tokens up under, which is why
 * `DEFAULT_OPENAI_COMPATIBLE_MODEL` (in presets.ts) is a Hugging Face id that
 * `data/seed-models.json` already carries authoritative metadata for.
 */

/**
 * Embedder for any server speaking OpenAI's `POST /v1/embeddings` protocol.
 *
 * Verified against llama.cpp `llama-server` (build b10673) with
 * `Qwen3-Embedding-0.6B-Q8_0.gguf --embedding --pooling last`. The same wire
 * format is spoken by LM Studio, vLLM, text-embeddings-inference, LocalAI and
 * OpenAI itself, so one implementation covers all of them.
 *
 * **Why this can't be the Ollama provider with a different URL.** Ollama's
 * native API and the OpenAI protocol share no embedding surface. Pointing
 * `OLLAMA_BASE_URL` at a llama-server yields HTTP 404 on every call
 * (`/api/show`, `/api/tags` and `/api/embeddings` all verified 404 against
 * b10673), so `OllamaEmbedder.init()` fails before the first vector.
 *
 * **Capability degradation vs. Ollama**, all intentional — the protocol
 * carries no equivalent, so we degrade rather than guess:
 *   - No auto-pull. The server owns its weights; there is no `/api/pull`.
 *   - `dimensions()` is probed with one throwaway embed rather than read from
 *     a metadata endpoint, unless `EMBEDDING_DIM` declares it up front.
 *   - `getContextLength()` / `identityHash()` come from llama.cpp's optional
 *     `/props`. On servers without it both return null and the caller falls
 *     back to its own defaults — never an error.
 */
export class OpenAICompatibleEmbedder implements Embedder {
  private cachedDim: number | undefined;
  private cachedContextLength: number | undefined;
  private cachedIdentity: string | null = null;
  /** Sticky last error from init()/embed(), cleared by the next success.
   *  Surfaced through `dimensions()` so callers that read the dim directly
   *  (e.g. the `index_status` tool) get the actionable cause instead of the
   *  generic "dim not known yet" — mirrors `OllamaEmbedder`. */
  private lastError: Error | null = null;
  private _phase: OpenAICompatiblePhase = { status: 'not-started' };
  /** Authoritative prefixes pushed in by `metadata-resolver.ts` after
   *  bootstrap. Null until then; `getPrefix()` covers the gap. */
  private _metadata: EmbedderMetadata | null = null;
  private readonly apiKey: string | undefined;
  private readonly presetName: string | null;
  /** readonly (not private) so the capacity layer can read it back, matching
   *  how `capacity.ts` reaches into `OllamaEmbedder.baseUrl`. */
  readonly baseUrl: string;

  constructor(
    baseUrl: string = DEFAULT_OPENAI_COMPATIBLE_BASE_URL,
    private readonly model: string = DEFAULT_OPENAI_COMPATIBLE_MODEL,
    expectedDim?: number,
    apiKey?: string,
    presetName: string | null = null,
  ) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    if (expectedDim !== undefined) this.cachedDim = expectedDim;
    this.apiKey = apiKey && apiKey.trim() ? apiKey.trim() : undefined;
    this.presetName = presetName;
  }

  /** Synchronous lifecycle read; see `OpenAICompatiblePhase`. */
  get phase(): OpenAICompatiblePhase {
    return this._phase;
  }

  /** Synchronous read of the preset that chose this model (null when the user
   *  supplied `EMBEDDING_MODEL` directly). Mirrors `OllamaEmbedder`. */
  get presetNameForTest(): string | null {
    return this.presetName;
  }

  async init(): Promise<void> {
    this.lastError = null;
    this._phase = { status: 'probing' };
    try {
      // Best-effort: llama.cpp exposes `/props`, most other OpenAI-compatible
      // servers don't. Never fatal — a null result just means the caller uses
      // its own fallbacks.
      await this.fetchServerProps();
      // The protocol has no metadata endpoint that reports dimensionality, so
      // unless the user declared it we spend exactly one embed to learn it.
      // Empty input is accepted by llama-server (verified: HTTP 200, full
      // vector), which keeps the probe as cheap as possible.
      if (this.cachedDim === undefined) {
        await this.embed('', 'document');
      }
      this._phase = { status: 'ready' };
    } catch (err) {
      const wrapped = err instanceof Error ? err : new Error(String(err));
      this.lastError = wrapped;
      this._phase = { status: 'failed', error: wrapped };
      throw wrapped;
    }
  }

  /**
   * Read llama.cpp's `/props` for the live context window and a weights
   * fingerprint. Entirely best-effort: any non-200, schema variation or
   * network error leaves both fields unset.
   *
   * Verified shape (llama.cpp b10673):
   *   default_generation_settings.n_ctx → 8192   (the `-c` the server booted with)
   *   model_path                        → "./qwen3-embedding/…Q8_0.gguf"
   *   build_info                        → "b10673-f5e85d43a"
   */
  private async fetchServerProps(): Promise<void> {
    // Resolve into locals, then assign both fields exactly once at the end.
    //
    // This must OVERWRITE on every probe, including the failure paths, rather
    // than only on success. `init()` can run more than once against the same
    // instance, and the second run may hit a server that has been restarted —
    // possibly without `/props`, possibly serving different weights. Leaving
    // the previous probe's values in place would let `identityHash()` return
    // a fingerprint for weights the server no longer serves, and since
    // `bootstrap.ts` reindexes only when the stored and current hashes DIFFER,
    // a stale-but-matching hash silently suppresses the reindex that the swap
    // should have triggered — defeating the very drift guard this exists for.
    // `getContextLength()` would likewise hand the capacity layer a window the
    // current server never agreed to.
    //
    // Null/undefined is the honest answer for "this probe learned nothing",
    // and both callers already treat it that way: bootstrap gates on
    // `currentHash !== null` (no reindex, no re-stamp) and capacity falls back
    // to its own default. An unknown value is safe; a wrong one is not.
    let contextLength: number | undefined;
    let identity: string | null = null;
    try {
      const res = await fetch(`${this.baseUrl}/props`);
      if (res.ok) {
        const body = (await res.json()) as {
          default_generation_settings?: { n_ctx?: unknown };
          model_path?: unknown;
          build_info?: unknown;
        };
        const nCtx = body.default_generation_settings?.n_ctx;
        if (typeof nCtx === 'number' && Number.isFinite(nCtx) && nCtx > 0) {
          contextLength = nCtx;
        }
        // Weights fingerprint. `model_path` alone would be stable across a
        // rebuild of the same filename with different weights, so fold in
        // `build_info` too — bootstrap.ts only needs the value to CHANGE when
        // the served model changes, not to be cryptographically meaningful.
        const parts = [body.model_path, body.build_info].filter(
          (p): p is string => typeof p === 'string' && p.length > 0,
        );
        if (parts.length > 0) identity = parts.join('@');
      }
    } catch {
      // Best-effort — server has no /props, or isn't llama.cpp.
    }
    this.cachedContextLength = contextLength;
    this.cachedIdentity = identity;
  }

  async embed(text: string, taskType: 'document' | 'query' = 'document'): Promise<Float32Array> {
    this.lastError = null;
    try {
      return await this.embedInner(text, taskType);
    } catch (err) {
      this.lastError = err instanceof Error ? err : new Error(String(err));
      throw this.lastError;
    }
  }

  private async embedInner(text: string, taskType: 'document' | 'query'): Promise<Float32Array> {
    // Prefix resolution — identical precedence to OllamaEmbedder, and for the
    // same reason: the OpenAI protocol passes `input` through verbatim, so an
    // asymmetric model only sees a task prefix if WE inject it client-side.
    //   1. Authoritative resolved metadata (override / seed / HF / README).
    //   2. Hardcoded family heuristics, for the init-time probe and for models
    //      the resolver could only attribute as `fallback` / `none`.
    const isAuthoritative =
      this._metadata !== null &&
      this._metadata.prefixSource !== 'fallback' &&
      this._metadata.prefixSource !== 'none';
    const prefix = isAuthoritative
      ? taskType === 'query'
        ? this._metadata!.queryPrefix
        : this._metadata!.documentPrefix
      : this.getPrefix(taskType);
    // `replaceAll`, not `replace`: multi-`{text}` seed templates exist.
    const input = prefix.includes('{text}') ? prefix.replaceAll('{text}', text) : prefix + text;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model: this.model, input }),
      });
    } catch (err) {
      // Connection-level failure. The single most common cause by far is "the
      // server isn't running", so lead with the exact command that starts one.
      throw new Error(
        `Cannot reach the OpenAI-compatible embedding server at ${this.baseUrl}: ` +
          `${err instanceof Error ? err.message : String(err)}. ` +
          `Start one, e.g.: llama-server -m <model>.gguf --embedding --pooling last ` +
          `--port ${portOf(this.baseUrl)}`,
      );
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Embedding request failed: HTTP ${res.status} ${res.statusText}` +
          `${body ? ` — ${truncate(body, 300)}` : ''}. ` +
          `Endpoint: ${this.baseUrl}/v1/embeddings, model: "${this.model}".` +
          (res.status === 404
            ? ` HTTP 404 usually means the server has no /v1/embeddings route — ` +
              `llama-server needs the --embedding flag to expose it.`
            : '') +
          (res.status === 401 || res.status === 403
            ? ` Set EMBEDDING_API_KEY if the server requires a token.`
            : ''),
      );
    }

    const raw = (await res.json()) as {
      data?: Array<{ embedding?: unknown }>;
      error?: { message?: string };
    };
    if (raw.error?.message) {
      throw new Error(`Embedding server returned an error: ${raw.error.message}`);
    }
    const first = Array.isArray(raw.data) ? raw.data[0]?.embedding : undefined;
    const flat = coerceVector(first);
    if (flat === null || flat.length === 0) {
      throw new Error(
        `Embedding server at ${this.baseUrl} returned no usable vector for model "${this.model}". ` +
          `If this is llama-server, confirm it was started with --embedding and that the GGUF is an ` +
          `embedding model (a chat model will not produce pooled embeddings).`,
      );
    }

    // Normalise defensively. llama-server L2-normalises by default (verified:
    // ‖v‖ = 1.000000) and so do most servers, but it is NOT part of the OpenAI
    // contract — and the `Embedder` interface promises a normalised vector
    // because the whole search path compares with a plain dot product. Cheap
    // insurance against a backend that skips it (e.g. llama-server started
    // with --embd-normalize -1).
    const vec = l2Normalize(flat);

    if (this.cachedDim === undefined) {
      this.cachedDim = vec.length;
    } else if (this.cachedDim !== vec.length) {
      throw new Error(
        `Embedding dim mismatch: expected ${this.cachedDim} but the server returned ${vec.length} ` +
          `for model "${this.model}". The server may have been restarted with a different model — ` +
          `check EMBEDDING_DIM, or clear it to let obsidian-brain probe the live value.`,
      );
    }
    return vec;
  }

  dimensions(): number {
    if (this.cachedDim === undefined) {
      if (this.lastError) throw this.lastError;
      throw new Error(
        'OpenAICompatibleEmbedder dimensions not known yet — call init() or embed() once first.',
      );
    }
    return this.cachedDim;
  }

  /** `openai:<model>`. The prefix is the PROTOCOL, not the vendor — every
   *  backend reachable this way shares it so a user switching from
   *  llama.cpp to vLLM with the same checkpoint keeps their index. */
  modelIdentifier(): string {
    return `openai:${this.model}`;
  }

  providerName(): string {
    return 'openai-compatible';
  }

  /** Live context window from llama.cpp's `/props`, or null on servers that
   *  don't expose it. */
  getContextLength(): number | null {
    return this.cachedContextLength ?? null;
  }

  /** `<model_path>@<build_info>` from `/props`, or null. Used by bootstrap as
   *  a second change-detection signal so swapping the served GGUF triggers a
   *  reindex even though the configured model LABEL never changed — the most
   *  likely silent-drift path for this provider. */
  identityHash(): string | null {
    return this.cachedIdentity;
  }

  setMetadata(meta: EmbedderMetadata): void {
    this._metadata = meta;
  }

  getMetadata(): EmbedderMetadata | null {
    return this._metadata;
  }

  async dispose(): Promise<void> {
    // Nothing to release — the inference server owns the model lifecycle.
  }

  /**
   * Hardcoded family heuristics, used only until `metadata-resolver.ts` supplies
   * authoritative prefixes. Kept in sync with `OllamaEmbedder.getPrefix()`, with
   * one deliberate difference: the model id here is typically a Hugging Face
   * checkpoint id (`Qwen/Qwen3-Embedding-0.6B`) rather than an Ollama tag
   * (`qwen3-embedding:0.6b`), so the substring tests are written to catch both.
   */
  private getPrefix(taskType: 'document' | 'query'): string {
    const m = this.model.toLowerCase();
    if (m.includes('nomic')) {
      return taskType === 'query' ? 'search_query: ' : 'search_document: ';
    }
    if (m.includes('e5-')) {
      return taskType === 'query' ? 'query: ' : 'passage: ';
    }
    // Qwen3-Embedding / gte-Qwen: asymmetric, instruction-tuned queries.
    // The seed carries the full `Instruct: …\nQuery:` template; this is the
    // conservative stand-in for the pre-metadata window.
    if (m.includes('qwen')) {
      return taskType === 'query' ? 'Query: ' : '';
    }
    if (m.includes('mxbai') || m.includes('mixedbread')) {
      return taskType === 'query'
        ? 'Represent this sentence for searching relevant passages: '
        : '';
    }
    // bge-m3 and everything else: no prefix, per FlagEmbedding research.
    return '';
  }
}

/**
 * Normalise a user-supplied base URL to a bare origin (+ optional path) that
 * `/v1/embeddings` can be appended to.
 *
 * Both `http://host:8080` and `http://host:8080/v1` are things users copy out
 * of OpenAI-client documentation, and silently producing `/v1/v1/embeddings`
 * from the second is a 404 that costs an hour to diagnose. Strip a trailing
 * `/v1` (and any trailing slash) so both spellings work.
 */
export function normalizeBaseUrl(url: string): string {
  let u = url.trim().replace(/\/+$/, '');
  if (u.toLowerCase().endsWith('/v1')) u = u.slice(0, -3).replace(/\/+$/, '');
  return u;
}

/** Best-effort port extraction, for the "start a server like this" hint. */
function portOf(baseUrl: string): string {
  try {
    const p = new URL(baseUrl).port;
    return p || '8080';
  } catch {
    return '8080';
  }
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * Coerce the `embedding` field into a flat number array.
 *
 * `/v1/embeddings` returns a flat array, but llama.cpp's NATIVE `/embedding`
 * route returns `[[...]]`, and a server started with `--pooling none` returns
 * one vector per token through either route. Accepting the nested shape (and
 * taking the first row) means a user who misconfigures pooling gets a working
 * index instead of a type error — while the `null` return for anything else
 * keeps the error message specific.
 */
export function coerceVector(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  if (typeof v[0] === 'number') {
    return (v as number[]).every((x) => typeof x === 'number' && Number.isFinite(x))
      ? (v as number[])
      : null;
  }
  if (Array.isArray(v[0])) {
    const row = v[0] as unknown[];
    return row.every((x) => typeof x === 'number' && Number.isFinite(x as number))
      ? (row as number[])
      : null;
  }
  return null;
}

/** L2-normalise, tolerating an already-normalised input and a zero vector. */
export function l2Normalize(values: number[]): Float32Array {
  const out = new Float32Array(values);
  let sum = 0;
  for (const v of out) sum += v * v;
  const norm = Math.sqrt(sum);
  // Already unit-length (the common case) or degenerate — leave it alone.
  if (norm === 0 || Math.abs(norm - 1) < 1e-3) return out;
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}
