import type { ServerContext } from '../context.js';
import type { OllamaPhase } from '../embeddings/ollama.js';

export interface PreparingResponse {
  status: 'preparing' | 'failed';
  message: string;
  phase?: OllamaPhase;
}

/**
 * v1.7.22 (O3/N2): shared preparing-state shape for tools that need the
 * embedder. Returns `null` when the embedder is fully ready — callers then
 * proceed normally. Returns a `failed` envelope if startup raised; otherwise
 * a `preparing` envelope, with Ollama pull progress surfaced verbatim when
 * the embedder is mid-pull.
 *
 * Callers (search.ts, reindex.ts) should gate on `!ctx.embedderReady()` and
 * forward this response straight back to the MCP client when non-null. The
 * extra `phase` field lets clients display a progress bar without parsing
 * the human-readable `message`.
 */
export function describeEmbedderPreparing(ctx: ServerContext): PreparingResponse | null {
  if (ctx.embedderReady()) return null;

  if (ctx.initError) {
    return {
      status: 'failed',
      message: `Embedding model failed to load: ${String(ctx.initError)}. Restart the MCP server to retry. For diagnosis, run 'obsidian-brain models check <model-id>' on the command line.`,
    };
  }

  const phase = readOllamaPhase(ctx);
  if (phase?.status === 'pulling') {
    return {
      status: 'preparing',
      message: `Embedding model pull in progress: ${phase.completedMb} MB / ${phase.totalMb} MB (${phase.pct}%) — ${phase.phase}. Retry once the pull completes.`,
      phase,
    };
  }
  if (phase?.status === 'failed') {
    return {
      status: 'failed',
      message: `Embedding model failed to load: ${String(phase.error)}. Restart the MCP server to retry.`,
      phase,
    };
  }

  return {
    status: 'preparing',
    message: ctx.reindexInProgress
      ? "Re-embedding your vault against the current embedder (this happens when the embedding model changes or its prefix strategy is updated). Search/reindex will resume automatically."
      : "Embedding model is still initialising on first run (~34MB local download, or a multi-hundred-MB Ollama pull). Retry shortly.",
    ...(phase ? { phase } : {}),
  };
}

function readOllamaPhase(ctx: ServerContext): OllamaPhase | undefined {
  // Duck-typed: only OllamaEmbedder exposes `.phase`. Transformers-backed
  // embedders return undefined here, which is fine — the generic
  // "still initialising" message covers them.
  if (!ctx.embedder) return undefined;
  const candidate = (ctx.embedder as { phase?: OllamaPhase }).phase;
  return candidate && typeof candidate === 'object' && 'status' in candidate ? candidate : undefined;
}
