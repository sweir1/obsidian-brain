import type { Embedder, EmbedderMetadata } from './types.js';
import { DEFAULT_OLLAMA_MODEL } from './presets.js';
import { debugLog } from '../util/debug-log.js';

debugLog('module-load: src/embeddings/ollama.ts');

/**
 * Ollama-backed Embedder. Talks to a local (or remote) Ollama server's
 * `/api/embeddings` endpoint. Task-type prefixes are applied automatically
 * for known asymmetric models (nomic-embed-text, qwen embeddings,
 * mxbai-embed-large / mixedbread) — other models get the raw text through.
 *
 * Dimensions are either supplied up-front via the `expectedDim` constructor
 * arg (typically from `OLLAMA_EMBEDDING_DIM`) or discovered by the first
 * `embed()` call. Callers that need `dimensions()` synchronously before any
 * embed — e.g. the bootstrap compatibility check — should call `init()`,
 * which probes once when no dim was declared.
 */
export class OllamaEmbedder implements Embedder {
  private cachedDim: number | undefined;
  private cachedDigest: string | null = null;
  private cachedContextLength: number | undefined;
  /** Resolved metadata pushed in by `metadata-resolver.ts` after `bootstrap()`
   *  runs. When set, embed() uses these prefixes instead of the hardcoded
   *  family heuristics in `getPrefix()` — that's how `models override` /
   *  `models add` flow through to Ollama. Null at construction; populated
   *  in production by `context.ts` orchestration. Falls back to the
   *  hardcoded `getPrefix()` when null (init-time, tests). */
  private _metadata: EmbedderMetadata | null = null;
  /** The user's explicit `OLLAMA_NUM_CTX` if they set one, else undefined.
   *  Resolved against the model's real `context_length` (from `/api/show`)
   *  during init() — see `effectiveNumCtx`. */
  private readonly explicitNumCtx: number | undefined;
  /** Fallback when `/api/show` is unreachable and the user didn't set
   *  OLLAMA_NUM_CTX. Most embedding models cap well below this. */
  private static readonly NUM_CTX_FALLBACK = 8192;

  constructor(
    // readonly (not private) — capacity probing via Ollama /api/show needs to read it
    readonly baseUrl: string = 'http://localhost:11434',
    private readonly model: string = DEFAULT_OLLAMA_MODEL,
    expectedDim?: number,
    numCtx?: number,
  ) {
    if (expectedDim !== undefined) this.cachedDim = expectedDim;
    this.explicitNumCtx = numCtx;
  }

  /** Resolved `num_ctx` for `/api/embeddings` calls. Precedence:
   *    1. User's `OLLAMA_NUM_CTX` if set (they know what they want).
   *    2. The model's real `context_length` from `/api/show` (verified
   *       live: nomic=2048, mxbai-embed-large=512, all-minilm=512 —
   *       sending the legacy 8192 default to nomic exceeded the model's
   *       hard cap).
   *    3. Fallback `NUM_CTX_FALLBACK` (8192) when neither is available. */
  private get effectiveNumCtx(): number {
    return this.explicitNumCtx ?? this.cachedContextLength ?? OllamaEmbedder.NUM_CTX_FALLBACK;
  }

  async init(): Promise<void> {
    // Two best-effort calls to populate cachedDim, cachedContextLength,
    // and cachedDigest WITHOUT firing a test embedding. Verified live
    // against nomic-embed-text (137M, GGUF F16):
    //
    //   /api/show  → model_info["<family>.embedding_length"] = real dim
    //              → model_info["<family>.context_length"]   = real max-tokens
    //              → capabilities = ["embedding"] (sanity-check this IS
    //                an embedding model, not an LLM accidentally pointed at)
    //   /api/tags  → digest = sha256 of the manifest, shifts when
    //                `ollama pull` swaps the underlying weights under the
    //                same tag. Drives `identityHash()` for change-detection
    //                in bootstrap.ts.
    //
    // Both are best-effort: any failure (Ollama down, schema variation,
    // unknown architecture) falls through to the legacy test-embedding
    // probe so older Ollama versions / unusual architectures still work.
    await this.fetchModelInfo();
    await this.fetchDigest();
    // Legacy fallback: if /api/show didn't expose embedding_length and
    // the user didn't supply OLLAMA_EMBEDDING_DIM, probe with an empty
    // embed call. Same behaviour as before this refactor.
    if (this.cachedDim === undefined) {
      await this.embed('', 'document');
    }
  }

  /** Pull dim, max-tokens, and embedding-capability from `/api/show`. */
  private async fetchModelInfo(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/api/show`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: this.model }),
      });
      if (!res.ok) return;
      const body = (await res.json()) as {
        capabilities?: string[];
        model_info?: Record<string, unknown>;
      };
      // Capability sanity check — fail fast if the user pointed us at an
      // LLM by mistake, with a much better error than "Ollama returned
      // an empty embedding" once the first real embed runs.
      if (Array.isArray(body.capabilities) && body.capabilities.length > 0) {
        if (!body.capabilities.includes('embedding')) {
          throw new Error(
            `Ollama model "${this.model}" advertises capabilities ${JSON.stringify(body.capabilities)} ` +
            `but not "embedding". Pick an embedding-capable model (e.g. nomic-embed-text, bge-m3, ` +
            `mxbai-embed-large) and set EMBEDDING_MODEL accordingly.`,
          );
        }
      }
      // Walk model_info for keys ending in `.embedding_length` and
      // `.context_length` — the architecture prefix varies by model
      // (nomic-bert, bert, llama, etc.) so suffix-matching is the
      // architecture-agnostic way to extract these.
      if (body.model_info && typeof body.model_info === 'object') {
        for (const [key, value] of Object.entries(body.model_info)) {
          if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
          if (this.cachedDim === undefined && key.endsWith('.embedding_length')) {
            this.cachedDim = value;
          } else if (this.cachedContextLength === undefined && key.endsWith('.context_length')) {
            this.cachedContextLength = value;
          }
        }
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Ollama model')) throw err;
      // Anything else (network, JSON parse, schema variation) — leave
      // fields unset, init() falls through to the legacy probe path.
    }
  }

  /** Pull manifest digest from `/api/tags` for the active model. */
  private async fetchDigest(): Promise<void> {
    try {
      const res = await fetch(`${this.baseUrl}/api/tags`);
      if (!res.ok) return;
      const body = (await res.json()) as { models?: Array<{ name?: string; digest?: string }> };
      if (!Array.isArray(body.models)) return;
      // Match by exact name OR by name-without-tag (`bge-m3` matches
      // `bge-m3:latest` since that's the implicit default Ollama applies).
      const wantBare = this.model.includes(':') ? this.model : `${this.model}:latest`;
      for (const m of body.models) {
        if (!m.name) continue;
        if (m.name === this.model || m.name === wantBare) {
          if (typeof m.digest === 'string' && m.digest.length > 0) {
            this.cachedDigest = m.digest;
          }
          return;
        }
      }
    } catch {
      // Best-effort — leave digest null on any failure.
    }
  }

  /** Expose the model's authoritative max-token context (from `/api/show`)
   *  for the capacity layer to read. Null when unavailable. */
  getContextLength(): number | null {
    return this.cachedContextLength ?? null;
  }

  async embed(text: string, taskType: 'document' | 'query' = 'document'): Promise<Float32Array> {
    // Prefix resolution. Ollama itself does NOT auto-apply prefixes — its
    // `/api/embeddings` template is `{{ .Prompt }}`, pass-through. The
    // prompt we send is the prompt the model sees, character-for-character.
    // So WE inject the prefix client-side every call.
    //
    // Source-of-truth precedence:
    //   1. Resolved metadata (`_metadata`) populated by metadata-resolver
    //      after bootstrap. Reflects user `models override` / `models add`
    //      / bundled seed / Tier 3 README fingerprinting.
    //   2. Hardcoded family heuristics (`getPrefix`) — fallback when
    //      metadata isn't populated yet (init-time probe call) or in
    //      tests that bypass the resolver. Matches the canonical preset
    //      set's prefixes 1:1, so production behavior is unchanged for
    //      users not using overrides.
    const prefix = this._metadata
      ? (taskType === 'query' ? this._metadata.queryPrefix : this._metadata.documentPrefix)
      : this.getPrefix(taskType);
    // Runtime substitution for templates with `{text}` placeholders. The
    // build-seed step (`scripts/build-seed.py:_normalize_prompt_template`)
    // ships either plain prefixes or templates whose only placeholder is
    // `{text}` (single or multiple occurrences, e.g.
    // "Task: {text}\nQuery: {text}"). Anything containing a non-`{text}`
    // placeholder ({task}, {instruction}, ...) is dropped at build time.
    // `replaceAll` (not `replace`) is required: multi-`{text}` templates
    // exist in the wild.
    const prompt = prefix.includes('{text}') ? prefix.replaceAll('{text}', text) : prefix + text;
    const res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: this.model,
        prompt,
        options: { num_ctx: this.effectiveNumCtx },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(
        `Ollama embed failed: HTTP ${res.status} ${res.statusText}${body ? ` — ${body}` : ''}. ` +
          `Is Ollama running at ${this.baseUrl} with model "${this.model}" pulled? ` +
          `Try: ollama pull ${this.model}`,
      );
    }
    const { embedding } = (await res.json()) as { embedding?: number[] };
    if (!Array.isArray(embedding) || embedding.length === 0) {
      throw new Error(
        `Ollama /api/embeddings returned an empty vector for model "${this.model}". ` +
          `The model may not be an embedding model — try "nomic-embed-text" or "mxbai-embed-large".`,
      );
    }
    const vec = new Float32Array(embedding);
    if (this.cachedDim === undefined) {
      this.cachedDim = vec.length;
    } else if (this.cachedDim !== vec.length) {
      throw new Error(
        `Ollama dim mismatch: expected ${this.cachedDim} but model "${this.model}" returned ${vec.length}. ` +
          `Check OLLAMA_EMBEDDING_DIM matches the model.`,
      );
    }
    return vec;
  }

  dimensions(): number {
    if (this.cachedDim === undefined) {
      throw new Error(
        'OllamaEmbedder dimensions not known yet — call init() or embed() once first, ' +
          'or pass OLLAMA_EMBEDDING_DIM so the dim is known up front.',
      );
    }
    return this.cachedDim;
  }

  modelIdentifier(): string {
    return `ollama:${this.model}`;
  }

  providerName(): string {
    return 'ollama';
  }

  /** Manifest digest of the active Ollama model (sha256 from `/api/tags`),
   *  or null when Ollama was unreachable / didn't return one at init time. */
  identityHash(): string | null {
    return this.cachedDigest;
  }

  /** Accept the resolver's authoritative prefix strings. After this call,
   *  embed() prefers these over the hardcoded family heuristics. Called
   *  by context.ts orchestration after `resolveModelMetadata()` finishes. */
  setMetadata(meta: EmbedderMetadata): void {
    this._metadata = meta;
  }

  /** Diagnostic accessor; mirrors TransformersEmbedder.getMetadata(). */
  getMetadata(): EmbedderMetadata | null {
    return this._metadata;
  }

  async dispose(): Promise<void> {
    // No local resources — Ollama owns the model lifecycle.
  }

  private getPrefix(taskType: 'document' | 'query'): string {
    const m = this.model.toLowerCase();
    if (m.includes('nomic')) {
      return taskType === 'query' ? 'search_query: ' : 'search_document: ';
    }
    // E5 family (multilingual-e5-small/base/large and e5-*-v2).
    // Previously fell through silently causing ~20-30% retrieval quality regression.
    if (m.includes('e5-')) {
      return taskType === 'query' ? 'query: ' : 'passage: ';
    }
    // Qwen embedding family (all variants including qwen3-embedding-*) —
    // asymmetric: "Query: " prefix on queries, empty on documents.
    if (m.includes('qwen')) {
      return taskType === 'query' ? 'Query: ' : '';
    }
    if (m.includes('mxbai') || m.includes('mixedbread')) {
      return taskType === 'query'
        ? 'Represent this sentence for searching relevant passages: '
        : '';
    }
    // bge-m3 and all other models: INTENTIONALLY no-prefix per FlagEmbedding research —
    // bge-m3's dense head is trained without task-type prefixes.
    return '';
  }
}
