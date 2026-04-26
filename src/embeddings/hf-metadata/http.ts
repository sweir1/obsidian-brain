import type { Dtype } from './index.js';

export const HF_BASE = 'https://huggingface.co';
export const HF_API = 'https://huggingface.co/api';

export const ONNX_FILE_BY_DTYPE: Record<Dtype, string> = {
  fp32: 'model.onnx',
  fp16: 'model_fp16.onnx',
  q8: 'model_quantized.onnx',
  q4: 'model_q4.onnx',
  q4f16: 'model_q4f16.onnx',
  int8: 'model_int8.onnx',
  uint8: 'model_uint8.onnx',
  bnb4: 'model_bnb4.onnx',
};

/**
 * Fetch raw text or JSON from HF with retry+backoff on 5xx, no-retry on 4xx,
 * AbortController-based timeout. Returns null on permanent (404) or
 * exhausted-retry failures so callers can decide their fallback per-file.
 */
export async function fetchWithRetry(
  url: string,
  opts: { timeoutMs: number; retries: number; fetcher: typeof fetch },
): Promise<Response | null> {
  for (let attempt = 0; attempt <= opts.retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs);
    try {
      const res = await opts.fetcher(url, { signal: ctrl.signal });
      clearTimeout(timer);
      // 5xx → retry. 4xx → permanent, return null. 2xx/3xx → return.
      if (res.status >= 500 && attempt < opts.retries) {
        await sleep(200 * (attempt + 1));
        continue;
      }
      if (!res.ok) return null;
      return res;
    } catch (err) {
      clearTimeout(timer);
      // AbortError or network error: retry if budget remains.
      if (attempt < opts.retries) {
        await sleep(200 * (attempt + 1));
        continue;
      }
      return null;
    }
  }
  return null;
}

export async function fetchJson<T>(url: string, opts: { timeoutMs: number; retries: number; fetcher: typeof fetch }): Promise<T | null> {
  const res = await fetchWithRetry(url, opts);
  if (!res) return null;
  try {
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export async function fetchText(url: string, opts: { timeoutMs: number; retries: number; fetcher: typeof fetch }): Promise<string | null> {
  const res = await fetchWithRetry(url, opts);
  if (!res) return null;
  try {
    return await res.text();
  } catch {
    return null;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
