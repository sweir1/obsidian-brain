/**
 * Regex patterns that indicate a chunk is too large for the embedder.
 * On these errors we skip the chunk and continue rather than aborting the
 * entire reindex (research-backed: NAACL 2025 + production libraries
 * LangChain / LlamaIndex / FastEmbed / Haystack all do skip+log).
 */
const TOO_LONG_PATTERNS = [
  /input length exceeds/i,
  /context length/i,
  /too many tokens/i,
  /maximum context length/i,
  /HTTP 400.*length/i,
  /input_too_long/i,
  /Cannot broadcast|shape mismatch/i,
];

/**
 * Regex patterns that indicate the embedder itself is dead / unreachable.
 * On these errors we re-throw so the whole reindex pass aborts — per-chunk
 * retry doesn't make sense when the host is down.
 *
 * "Offline / network" means the TCP layer is broken: the host refused the
 * connection, DNS failed, or the connection was reset. We deliberately do NOT
 * match on the bare word "network" because ONNX Runtime surfaces errors like
 * "neural network input tensor shape mismatch" that contain "network" but are
 * actually chunk-too-long errors — those should be skipped, not aborted.
 */
const DEAD_EMBEDDER_PATTERNS = [
  /ECONNREFUSED/i,
  /ENOTFOUND/i,
  /ECONNRESET/i,
  /getaddrinfo/i,
  // Generic phrasing for fetch/HTTP clients that surface "network error",
  // "network down", or "network unreachable" — but not "neural network".
  /network (error|down|unreachable)/i,
  /EmbedderLoadError/i,
  /kind.*offline/i,
];

export function isTooLongError(msg: string): boolean {
  return TOO_LONG_PATTERNS.some((re) => re.test(msg));
}

export function isDeadEmbedderError(msg: string): boolean {
  return DEAD_EMBEDDER_PATTERNS.some((re) => re.test(msg));
}
