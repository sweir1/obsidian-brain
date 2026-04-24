import type { Embedder } from './types.js';

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

  constructor(
    private readonly baseUrl: string = 'http://localhost:11434',
    private readonly model: string = 'nomic-embed-text',
    expectedDim?: number,
  ) {
    if (expectedDim !== undefined) this.cachedDim = expectedDim;
  }

  async init(): Promise<void> {
    // Ollama has no per-process setup — the server is already running (or
    // it isn't, in which case the first embed() will surface a clear
    // error). If the dim wasn't declared up front, probe now so
    // `dimensions()` is callable synchronously afterwards.
    if (this.cachedDim === undefined) {
      await this.embed('', 'document');
    }
  }

  async embed(text: string, taskType: 'document' | 'query' = 'document'): Promise<Float32Array> {
    const prefix = this.getPrefix(taskType);
    const res = await fetch(`${this.baseUrl}/api/embeddings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: this.model, prompt: prefix + text }),
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
