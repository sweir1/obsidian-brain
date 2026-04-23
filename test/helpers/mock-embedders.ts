/**
 * Two mock embedders for tests that don't want to load a real model.
 *
 *   - InstantMockEmbedder: init resolves immediately, embed returns zeros.
 *     Good for "seed" pipeline.index() calls that just need to populate the DB.
 *   - SlowMockEmbedder: controllable init promise — resolve or reject on
 *     demand from the test. Good for init-timing / init-failure coverage.
 *     embed() throws loudly; if a timing test accidentally touches the real
 *     embed path we want to know.
 */

import type { Embedder } from '../../src/embeddings/types.js';

export class InstantMockEmbedder implements Embedder {
  async init(): Promise<void> {}

  async embed(_text: string, _taskType?: 'document' | 'query'): Promise<Float32Array> {
    return new Float32Array(384);
  }

  dimensions(): number {
    return 384;
  }

  modelIdentifier(): string {
    return 'mock/instant';
  }

  providerName(): string {
    return 'mock';
  }

  async dispose(): Promise<void> {}
}

export class SlowMockEmbedder implements Embedder {
  private _resolve!: () => void;
  private _reject!: (err: unknown) => void;
  private _promise: Promise<void>;

  constructor() {
    this._promise = new Promise<void>((res, rej) => {
      this._resolve = res;
      this._reject = rej;
    });
  }

  /** Resolve the pending init — simulates successful model download. */
  resolveInit(): void {
    this._resolve();
  }

  /** Reject the pending init — simulates a download failure. */
  rejectInit(err: unknown): void {
    this._reject(err);
  }

  async init(): Promise<void> {
    await this._promise;
  }

  async embed(_text: string, _taskType?: 'document' | 'query'): Promise<Float32Array> {
    throw new Error(
      'SlowMockEmbedder.embed() should not be called — embedder not expected to run in init-timing tests',
    );
  }

  dimensions(): number {
    return 384;
  }

  modelIdentifier(): string {
    return 'mock/slow-embedder';
  }

  providerName(): string {
    return 'mock';
  }

  async dispose(): Promise<void> {}
}
