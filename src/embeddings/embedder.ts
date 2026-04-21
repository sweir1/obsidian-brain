import { pipeline } from '@huggingface/transformers';

const DEFAULT_MODEL = 'Xenova/all-MiniLM-L6-v2';

// The `pipeline()` generic return type from @huggingface/transformers is a
// tagged union over every supported task, which hits TS2590 ("union type too
// complex") under strict mode. We cast through `unknown` to a minimal shape.
interface Extractor {
  (text: string, options: { pooling: 'mean'; normalize: boolean }): Promise<{
    tolist(): number[][];
  }>;
  dispose(): Promise<void>;
}

export class Embedder {
  private extractor: Extractor | null = null;
  private _dim: number | null = null;
  private readonly _model: string;
  private lastRun: Promise<void> = Promise.resolve();

  constructor(model?: string) {
    this._model = model ?? process.env.EMBEDDING_MODEL ?? DEFAULT_MODEL;
  }

  async init(): Promise<void> {
    const p = (await pipeline('feature-extraction', this._model, {
      dtype: 'q8',
    })) as unknown as Extractor;
    this.extractor = p;
    // Probe output length so callers can validate the DB's vec0 dim before
    // any embeds are written. Space is a cheap input.
    const probe = await p(' ', { pooling: 'mean', normalize: true });
    const vec = probe.tolist()[0];
    if (!vec || vec.length === 0) {
      throw new Error(
        `Embedder produced empty vector for model "${this._model}". ` +
          `Check the model exists on Hugging Face and outputs sentence embeddings.`,
      );
    }
    this._dim = vec.length;
  }

  get dim(): number {
    if (this._dim === null) {
      throw new Error('Embedder not initialized. Call init() first.');
    }
    return this._dim;
  }

  get model(): string {
    return this._model;
  }

  async embed(text: string): Promise<Float32Array> {
    if (!this.extractor) throw new Error('Embedder not initialized. Call init() first.');
    const extractor = this.extractor;
    const run = this.lastRun.then(async () =>
      extractor(text, {
        pooling: 'mean',
        normalize: true,
      }),
    );
    // Chain regardless of previous failure so one throw doesn't permanently wedge the queue.
    this.lastRun = run.then(
      () => undefined,
      () => undefined,
    );
    const output = await run;
    return new Float32Array(output.tolist()[0] ?? []);
  }

  async dispose(): Promise<void> {
    if (this.extractor) {
      await this.extractor.dispose();
      this.extractor = null;
    }
  }

  static buildEmbeddingText(
    title: string,
    tags: string[],
    content: string,
  ): string {
    const firstParagraph = content.split(/\n\n+/)[0] ?? '';
    const parts = [title];
    if (tags.length > 0) {
      parts.push(tags.join(', '));
    }
    if (firstParagraph) {
      parts.push(firstParagraph);
    }
    return parts.join('\n');
  }
}
