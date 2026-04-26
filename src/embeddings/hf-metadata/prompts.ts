import type { PrefixSource } from './index.js';
import type { PromptsBlock } from './internal-types.js';
import { fetchJson, fetchText, HF_BASE } from './http.js';
import { extractBaseModel, detectModelLanguage, languageToScript, resolvePromptsFromReadme } from './readme.js';

export interface ResolvedPrompts {
  query: string | null;
  document: string | null;
  source: PrefixSource;
  baseModel: string | null;
}

/**
 * Three-tier prompt resolution:
 *   1. canonical `config_sentence_transformers.json prompts` on this repo
 *   2. same JSON on the upstream `base_model` from README YAML frontmatter
 *   3. fingerprint the README itself (this repo, then the base_model's),
 *      with language-aware script filtering to keep BGE-en from picking
 *      the Chinese prefix when the EN+ZH README documents both
 */
export async function resolvePrompts(
  modelId: string,
  revision: string,
  opts: { timeoutMs: number; retries: number; fetcher: typeof fetch },
): Promise<ResolvedPrompts> {
  // Tier 1: canonical JSON on the model's own repo.
  const direct = await fetchJson<PromptsBlock>(
    `${HF_BASE}/${modelId}/resolve/${revision}/config_sentence_transformers.json`,
    opts,
  );
  if (direct?.prompts && (direct.prompts.query || direct.prompts.document || direct.prompts.passage)) {
    return {
      query: direct.prompts.query ?? null,
      document: direct.prompts.document ?? direct.prompts.passage ?? null,
      source: 'metadata',
      baseModel: null,
    };
  }

  // Tier 2: read README, extract base_model, re-fetch its config.
  const readme = await fetchText(`${HF_BASE}/${modelId}/resolve/${revision}/README.md`, opts);
  const baseModel = readme ? extractBaseModel(readme) : null;
  if (baseModel && baseModel !== modelId) {
    const upstream = await fetchJson<PromptsBlock>(
      `${HF_BASE}/${baseModel}/resolve/main/config_sentence_transformers.json`,
      opts,
    );
    if (upstream?.prompts && (upstream.prompts.query || upstream.prompts.document || upstream.prompts.passage)) {
      return {
        query: upstream.prompts.query ?? null,
        document: upstream.prompts.document ?? upstream.prompts.passage ?? null,
        source: 'metadata-base',
        baseModel,
      };
    }
  }

  // Tier 3: README fingerprinting — first this repo's README (if we have it),
  // then the upstream's. Language-aware script filter prevents BGE-en from
  // picking the Chinese prefix that appears more frequently in the
  // side-by-side EN+ZH README.
  const readmesToTry: Array<{ id: string; text: string }> = [];
  if (readme) readmesToTry.push({ id: modelId, text: readme });
  if (baseModel && baseModel !== modelId) {
    const upstreamReadme = await fetchText(
      `${HF_BASE}/${baseModel}/resolve/main/README.md`,
      opts,
    );
    if (upstreamReadme) readmesToTry.push({ id: baseModel, text: upstreamReadme });
  }
  for (const r of readmesToTry) {
    const lang = detectModelLanguage(r.text, r.id);
    const expectedScript = lang ? languageToScript(lang) : null;
    const fp = resolvePromptsFromReadme(r.text, expectedScript);
    if (fp.query || fp.document) {
      return {
        query: fp.query,
        document: fp.document,
        source: 'readme',
        baseModel,
      };
    }
  }

  return { query: null, document: null, source: 'none', baseModel };
}
