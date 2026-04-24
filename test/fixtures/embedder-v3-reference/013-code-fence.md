Cosine similarity in pure JavaScript:

```javascript
function cosineSimilarity(a, b) {
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot   += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
```

For normalized vectors (unit norm), `normA === normB === 1.0`, so the function reduces to a simple dot product. Embedding models that set `normalize: true` always return unit-norm vectors.
