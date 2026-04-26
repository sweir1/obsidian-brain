/**
 * Extract a `base_model:` value from a README's YAML frontmatter, or null.
 * Handles a single-string value or an array (returns the first entry).
 */
export function extractBaseModel(readme: string): string | null {
  const fm = readme.match(/^---\n([\s\S]*?)\n---/);
  if (!fm) return null;
  // Single-string form: `base_model: org/name`. Use `[ \t]*` (NOT `\s*`)
  // because `\s` matches `\n` and would silently swallow the line break,
  // making this regex incorrectly fire on the list form.
  const single = fm[1].match(/^base_model:[ \t]*(.+)$/m);
  if (single) {
    return single[1].trim().replace(/^["']|["']$/g, '');
  }
  // List form: `base_model:\n  - org/name`.
  const list = fm[1].match(/^base_model:[ \t]*\n[ \t]*-[ \t]*(.+)$/m);
  if (list) {
    return list[1].trim().replace(/^["']|["']$/g, '');
  }
  return null;
}

/**
 * Detect the model's primary language from YAML frontmatter `language:` or
 * (failing that) the model id's `-en-` / `-zh-` / `_ja` style suffix.
 * Returns ISO 639-1 code ('en', 'zh', 'ja', 'fa', 'ru', etc.) or null when
 * the model is multilingual or the language is undeclared.
 */
export function detectModelLanguage(readme: string | null, modelId: string): string | null {
  if (readme) {
    const fm = readme.match(/^---\n([\s\S]*?)\n---/);
    if (fm) {
      // Append `\n` so list-form's per-entry `\n` requirement still matches
      // the LAST entry (the captured frontmatter ends right before `---`,
      // not after a newline).
      const yaml = fm[1] + '\n';
      // Single-line: `language: en`
      const single = yaml.match(/^language:[ \t]*([a-z]{2,3})[ \t]*$/m);
      if (single) return single[1].toLowerCase();
      // List form: `language:\n  - en\n`
      const listMatch = yaml.match(/^language:[ \t]*\n((?:[ \t]*-[ \t]*[a-z]{2,3}[ \t]*\n)+)/m);
      if (listMatch) {
        const langs = [...listMatch[1].matchAll(/-[ \t]*([a-z]{2,3})/g)].map((m) => m[1]);
        if (langs.length === 1) return langs[0].toLowerCase();
        return null; // multilingual list — don't claim a single language
      }
    }
  }
  // Fall back to model-id suffix conventions.
  const idMatch = modelId.match(/[-_/]([a-z]{2})(?:[-_.]|$)/i);
  if (idMatch) {
    const code = idMatch[1].toLowerCase();
    if (
      ['en', 'zh', 'ja', 'ko', 'ar', 'fa', 'ru', 'de', 'fr', 'es', 'pt', 'it', 'nl', 'vi', 'tr', 'pl', 'hi'].includes(code)
    ) {
      return code;
    }
  }
  return null;
}

/**
 * Map an ISO 639 language code to its dominant script class. Multi-script
 * languages (Japanese mixes kana + kanji — both treated as 'cjk' here)
 * collapse to the broadest family. Returns null for languages we don't
 * have a mapping for (the language filter then no-ops).
 */
export function languageToScript(lang: string): string | null {
  const map: Record<string, string> = {
    en: 'latin', de: 'latin', fr: 'latin', es: 'latin', pt: 'latin',
    it: 'latin', nl: 'latin', vi: 'latin', tr: 'latin', pl: 'latin', id: 'latin',
    zh: 'cjk',   ja: 'cjk',   ko: 'cjk',
    ar: 'arabic', fa: 'arabic', ur: 'arabic',
    ru: 'cyrillic', uk: 'cyrillic', bg: 'cyrillic',
    hi: 'devanagari',
  };
  return map[lang] ?? null;
}

/**
 * Classify a candidate prefix string by dominant script. Used to filter
 * README-fingerprinted prefixes against the model's declared language —
 * fixes BGE-en picking the Chinese prefix because the EN+ZH README
 * documents both side-by-side and ZH appears more often.
 */
export function detectPrefixScript(prefix: string): string {
  // Strip punctuation/digits/whitespace before counting; pure-punctuation
  // strings shouldn't be reachable here (isPlausiblePrefix filters them
  // earlier) but defaulting to 'latin' is the safe choice.
  const text = prefix.replace(/[\s\d:：_/.\-,'"!?]/g, '');
  if (!text) return 'latin';
  let cjk = 0, arabic = 0, cyrillic = 0, latin = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3000 && cp <= 0x30ff) || (cp >= 0xac00 && cp <= 0xd7af)) cjk++;
    else if (cp >= 0x0600 && cp <= 0x06ff) arabic++;
    else if (cp >= 0x0400 && cp <= 0x04ff) cyrillic++;
    else if (cp >= 0x41 && cp <= 0x7a) latin++;
  }
  const max = Math.max(cjk, arabic, cyrillic, latin);
  if (max === 0) return 'latin';
  if (cjk === max) return 'cjk';
  if (arabic === max) return 'arabic';
  if (cyrillic === max) return 'cyrillic';
  return 'latin';
}

// ---------------------------------------------------------------------------
// Tier 3: README fingerprinting
//
// Catches older models whose query/document prefix is documented in README
// prose only — BGE family, vanilla Nomic, etc. Generic pattern-matching, no
// per-model branches. Two real bugs caught + fixed during smoke-testing
// against ~300 random HF models:
//
//   (1) `BAAI/bge-small-en-v1.5` resolved to the Chinese prefix because the
//       README documents EN + ZH side-by-side and ZH appears 10× vs EN 6×.
//       Fix: language-aware script filter — when the model declares a single
//       language, drop candidates whose script doesn't match.
//
//   (2) `sentence-transformers/all-MiniLM-L6-v2` resolved
//       `"Sentence embeddings:"` as a query prefix — that's a Python
//       `print()` label, not a model prefix. Fix: real prefixes always end
//       in `": "` (Latin colon + space) or `"："` (full-width CJK colon)
//       because they prepend to text. Bare `":"` is rejected.
// ---------------------------------------------------------------------------

/**
 * Fingerprint a README for query/document prefixes. Generic — counts quoted
 * candidate strings and ranks by frequency + presence of query/instruction
 * keywords. When `expectedScript` is set (i.e. the model declares a single
 * language), candidates with a non-matching script are dropped first.
 */
export function resolvePromptsFromReadme(
  readme: string,
  expectedScript: string | null = null,
): { query: string | null; document: string | null } {
  // Strip the YAML frontmatter so we don't pick prefix-shaped values like
  // `description: "query: ..."` from the metadata block.
  const body = readme.replace(/^---\n[\s\S]*?\n---\n?/, '');

  // Pull every quoted/backticked sub-200-char string. We over-collect on
  // purpose; isPlausiblePrefix below filters down to actual prefix shapes.
  const strings: string[] = [];
  for (const re of [/"([^"\n]{1,200})"/g, /'([^'\n]{1,200})'/g, /`([^`\n]{1,200})`/g]) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) strings.push(m[1]);
  }

  const counts = new Map<string, number>();
  const bump = (s: string) => counts.set(s, (counts.get(s) ?? 0) + 1);

  for (const s of strings) {
    // Pattern A — the whole string IS a prefix. Must end in `": "` (Latin)
    // or `"："` (CJK fullwidth) so we don't fire on Python print labels.
    if (/(: |：)$/.test(s) && isPlausiblePrefix(s)) bump(s);
    // Pattern B — string starts with a `prefix: <body>` shape, e.g.
    // `"search_query: <text>"`. Capture just the prefix.
    const m = s.match(/^([A-Za-z][A-Za-z0-9 _]{2,40}: )/);
    if (m && isPlausiblePrefix(m[1])) bump(m[1]);
  }

  if (counts.size === 0) return { query: null, document: null };

  let ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);

  // Language-aware filter: when the model is single-language, drop candidates
  // from other scripts. Only applies when at least one candidate matches the
  // expected script (otherwise we'd return nothing for valid LLM-instruct
  // prompts that happen to be in another script for some reason).
  if (expectedScript) {
    const matchingScript = ranked.filter(([p]) => detectPrefixScript(p) === expectedScript);
    if (matchingScript.length > 0) ranked = matchingScript;
  }

  // A doc prefix is a *label-style* identifier that names the text as a
  // passage/document — `passage: `, `document: `, `search_document: `, etc.
  // The structural rule: single token, no spaces, of the form
  // `[<word>_]passage(s)/document(s)<colon><space>`. NOT instruction-prose
  // that happens to contain "passage" mid-text (e.g. BGE's `Represent this
  // sentence for searching relevant passages: ` is a QUERY prefix).
  const isDocPrefix = (p: string) => /^([a-z_]+_)?(passage|document)s?\s*[:：]\s*$/i.test(p);
  // Multilingual query/instruction keywords — a candidate that hits any of
  // these is treated as credible even if it appears only once in the README.
  const queryWords = /(query|search|represent|instruction|为这个句子|سوال|质问)/i;

  const credible = ranked.filter(([p, c]) => c >= 2 || queryWords.test(p));
  if (credible.length === 0) return { query: null, document: null };

  let docPrefix: string | null = null;
  let queryPrefix: string | null = null;
  for (const [p] of credible) {
    if (!docPrefix && isDocPrefix(p)) docPrefix = p;
    else if (!queryPrefix && !isDocPrefix(p)) queryPrefix = p;
    if (queryPrefix && docPrefix) break;
  }

  return { query: queryPrefix, document: docPrefix };
}

/**
 * Is `s` a plausibly-formed model prefix? Real prefixes always end in
 * `": "` (Latin colon-space, because they prepend to text) or `"："`
 * (full-width CJK colon, which already includes spacing visually).
 * Bare `":"` is rejected — that filters out Python print labels like
 * `"Sentence embeddings:"` which the all-MiniLM README contains.
 */
function isPlausiblePrefix(s: string): boolean {
  if (s.length < 5 || s.length > 80) return false;
  // No newlines / structural punctuation — would mean we caught a code line.
  if (/[\n\r{}\[\]()=<>|;]/.test(s)) return false;
  // Trailing-shape requirement (the load-bearing fix).
  if (!/(: |：)$/.test(s)) return false;
  // Reject obvious code/output noise.
  const trimmed = s.replace(/\s+$/, '');
  if (/^[#/]/.test(trimmed)) return false;
  if (/Score\s*:|Options\s*:/i.test(trimmed)) return false;
  return true;
}
