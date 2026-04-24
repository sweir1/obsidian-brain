export type EmbedderLoadErrorKind = 'not-found' | 'no-onnx' | 'offline' | 'unknown';

export class EmbedderLoadError extends Error {
  constructor(
    public readonly kind: EmbedderLoadErrorKind,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'EmbedderLoadError';
  }
}

/**
 * Map a raw transformers.js / network error into an actionable EmbedderLoadError.
 * Regexes tested against @huggingface/transformers v4.2.0's actual throw shapes.
 */
export function classifyLoadError(modelId: string, err: unknown): EmbedderLoadError {
  const msg = err instanceof Error ? err.message : String(err);

  // Offline / network — check FIRST to beat generic "404" text in offline error bodies
  if (/ENOTFOUND|ECONNREFUSED|Failed to fetch|getaddrinfo|network|ETIMEDOUT/i.test(msg)) {
    return new EmbedderLoadError(
      'offline',
      `Cannot reach Hugging Face to download '${modelId}'. Connect to the internet and retry, or run \`obsidian-brain models prefetch\` when online to pre-cache the model.`,
      err,
    );
  }

  // No ONNX weights — must check before generic 404 since the HF 404 message sometimes mentions onnx
  if (/\.onnx/i.test(msg) && /(Could not locate|no such file|not found|404)/i.test(msg)) {
    return new EmbedderLoadError(
      'no-onnx',
      `Model '${modelId}' has no ONNX weights. transformers.js requires ONNX — use the Xenova port (try 'Xenova/${modelId.split('/').pop()}'), or set EMBEDDING_PROVIDER=ollama to switch providers.`,
      err,
    );
  }

  // Model id not found on HF
  if (/(404|not found|does not exist|repository.*not found)/i.test(msg)) {
    return new EmbedderLoadError(
      'not-found',
      `Model '${modelId}' not found on Hugging Face. Check spelling — the Xenova/* namespace is the most reliable source of ONNX-converted models. Run \`obsidian-brain models list\` to see known-good presets.`,
      err,
    );
  }

  // Unknown — re-wrap with original message so nothing is swallowed silently
  process.stderr.write(
    `obsidian-brain: unmapped embedder error (please report this message verbatim to github.com/sweir1/obsidian-brain/issues): ${msg}\n`,
  );
  return new EmbedderLoadError(
    'unknown',
    `Failed to load embedding model '${modelId}': ${msg}`,
    err,
  );
}
