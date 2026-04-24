The embedder pipeline wraps a transformers.js `pipeline` call and serialises concurrent requests via a promise chain.

```typescript
export class TransformersEmbedder {
  private lastRun: Promise<void> = Promise.resolve();

  async embed(text: string): Promise<Float32Array> {
    const run = this.lastRun.then(() => this.extractor(text, {
      pooling: 'mean',
      normalize: true,
    }));
    this.lastRun = run.then(() => undefined, () => undefined);
    const output = await run;
    return new Float32Array(output.tolist()[0] ?? []);
  }
}
```

Each call chains onto `lastRun`, ensuring at most one in-flight request to the ONNX runtime at any time.
