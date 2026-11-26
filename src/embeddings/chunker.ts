import { createHash } from 'node:crypto';
import { debugLog } from '../util/debug-log.js';

debugLog('module-load: src/embeddings/chunker.ts');

/**
 * Per-chunk configuration. Sensible defaults — callers rarely override.
 */
export interface ChunkerConfig {
  /** Soft max size (chars) for a single chunk. Oversized sections get split. */
  chunkSize: number;
  /** Heading depth we still split on (H1..Hn). Beyond this, a section stays atomic. */
  headingSplitDepth: number;
  /** Keep fenced code blocks whole even if oversized. */
  preserveCodeBlocks: boolean;
  /** Keep $$...$$ LaTeX blocks whole even if oversized. */
  preserveLatexBlocks: boolean;
  /** Drop chunks shorter than this after trimming. */
  minChunkChars: number;
}

/**
 * Build the default chunker config. `chunkBudgetChars` — sourced from
 * capacity.ts at runtime — should be passed as `chunkSize` by callers.
 * The fallback of 1000 chars is retained only for backward-compat in tests
 * and callers that don't yet have a capacity object; it no longer represents
 * a hardcoded model-family limit.
 *
 * Env override: OBSIDIAN_BRAIN_MAX_CHUNK_TOKENS (handled in capacity.ts).
 * Callers that pass `chunkBudgetChars` from getCapacity() automatically
 * honour the env var because getCapacity() reads it first.
 */
export const DEFAULT_CHUNKER_CONFIG: ChunkerConfig = {
  chunkSize: 1000,
  headingSplitDepth: 4,
  preserveCodeBlocks: true,
  preserveLatexBlocks: true,
  minChunkChars: 50,
};

/**
 * Build a ChunkerConfig from a capacity-provided char budget. Inherits all
 * other defaults from DEFAULT_CHUNKER_CONFIG so callers only need to supply
 * what varies.
 */
export function chunkerConfigFromBudget(chunkBudgetChars: number): ChunkerConfig {
  return { ...DEFAULT_CHUNKER_CONFIG, chunkSize: chunkBudgetChars };
}

/**
 * A single emitted chunk. `chunkIndex` is the ordinal within the parent note,
 * `contentHash` is a stable fingerprint over heading + content so the indexer
 * can skip re-embedding an unchanged chunk.
 */
export interface Chunk {
  chunkIndex: number;
  heading: string | null;
  headingLevel: number | null;
  content: string;
  contentHash: string;
  startLine: number;
  endLine: number;
}

interface Section {
  heading: string | null;
  headingLevel: number | null;
  content: string;
  startLine: number;
  endLine: number;
}

/**
 * Protected region in the source (fenced code block or LaTeX block) that
 * must not be split across chunks. Captured verbatim up-front so the
 * splitter treats it as one opaque unit.
 */
interface Protected {
  token: string;
  text: string;
}

const CODE_FENCE_RE = /```[\s\S]*?```/g;
const LATEX_BLOCK_RE = /\$\$[\s\S]*?\$\$/g;

// Use Unicode Private Use Area delimiters for sentinel tokens. PUA chars
// never appear in real markdown source, they are non-whitespace (so
// `.trim()` and `.split(' ')` don't remove them), and they're single
// code units so the sentinel length is stable across every counter.
// Counters are zero-padded to 4 digits; past 9999 they simply grow longer.
const PROTECT_OPEN = '';
const PROTECT_CLOSE = '';
// `\d+` rather than a fixed width: a note with more than 10k protected
// regions gets 5-digit counters, and those tokens must still be recognised
// (by hardCut, the size measure and restore) or they could be cut in half.
const PROTECT_TOKEN_RE = new RegExp(`${PROTECT_OPEN}\\d+${PROTECT_CLOSE}`, 'g');

/**
 * Split a markdown document into embedding-sized chunks.
 *
 * Strategy:
 *   1. Strip frontmatter.
 *   2. Replace protected regions (code fences + $$...$$) with sentinel tokens
 *      so later splits can't cut them in half.
 *   3. Segment by headings up to `headingSplitDepth`.
 *   4. For oversize sections, recursively split on paragraph → sentence → hard.
 *      Sizes are measured as if protected regions were already restored, so
 *      a region that fits within `chunkSize` is packed at its true size and
 *      stays whole.
 *   5. Restore protected regions. A restored piece can still exceed
 *      `chunkSize` when a single protected region is bigger than the budget
 *      (e.g. a 100 KB code fence): those are re-split on blank lines → lines
 *      → hard cut, since the region can't fit the embedder's window whole
 *      anyway. Every emitted chunk is therefore <= `chunkSize`.
 *   6. Emit Chunks.
 */
export function chunkMarkdown(content: string, config: ChunkerConfig = DEFAULT_CHUNKER_CONFIG): Chunk[] {
  if (!content) return [];

  const stripped = stripFrontmatter(content);
  if (!stripped.trim()) return [];

  const { text: safe, protectedRegions } = protectRegions(stripped, config);
  const byToken = new Map(protectedRegions.map((r) => [r.token, r.text]));
  const measure = makeRestoredMeasure(protectedRegions, byToken);

  const sections = splitByHeadings(safe, config.headingSplitDepth);

  const rawChunks: Array<Omit<Chunk, 'chunkIndex' | 'contentHash'>> = [];
  for (const section of sections) {
    const pieces = splitOversize(section.content, config, measure);
    for (const piece of pieces) {
      const restored = restoreProtected(piece, byToken).trim();
      // Upper-bound re-check after restore. Without it a short sentinel can
      // stand in for a 100+ KB code fence, pass every size check, and then
      // expand back into a chunk that wedges the embedder's tokenizer.
      const parts = restored.length > config.chunkSize
        ? splitRestoredOversize(restored, config.chunkSize)
        : [restored];
      for (const part of parts) {
        const content = part.trim();
        if (content.length < config.minChunkChars) continue;
        rawChunks.push({
          heading: section.heading,
          headingLevel: section.headingLevel,
          content,
          startLine: section.startLine,
          endLine: section.endLine,
        });
      }
    }
  }

  return rawChunks.map((c, i) => ({
    chunkIndex: i,
    heading: c.heading,
    headingLevel: c.headingLevel,
    content: c.content,
    startLine: c.startLine,
    endLine: c.endLine,
    contentHash: sha256(`${c.heading ?? ''} ${c.content}`),
  }));
}

/**
 * Build the text we actually feed to the embedder for a chunk. Heading is
 * prepended so semantic queries line up with heading-anchored content.
 */
export function buildChunkEmbeddingText(chunk: Chunk): string {
  if (chunk.heading) {
    return `${chunk.heading}\n\n${chunk.content}`;
  }
  return chunk.content;
}

/**
 * Build the stable chunk id from the parent node's id and the chunk index.
 * Uses `::` as the separator — node ids are file paths (no `::`) so this
 * is collision-safe.
 */
export function chunkId(nodeId: string, chunkIndex: number): string {
  return `${nodeId}::${chunkIndex}`;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function stripFrontmatter(raw: string): string {
  // Only strip when the document actually starts with `---\n`, otherwise a
  // `---` later in the body (horizontal rule) would clip real content.
  if (!raw.startsWith('---\n') && !raw.startsWith('---\r\n')) return raw;
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(raw);
  if (!match) return raw;
  return raw.slice(match[0].length);
}

function protectRegions(
  text: string,
  config: ChunkerConfig,
): { text: string; protectedRegions: Protected[] } {
  const regions: Protected[] = [];
  let out = text;
  let counter = 0;

  const replaceAll = (re: RegExp): void => {
    out = out.replace(re, (match) => {
      const token = `${PROTECT_OPEN}${String(counter).padStart(4, '0')}${PROTECT_CLOSE}`;
      regions.push({ token, text: match });
      counter++;
      return token;
    });
  };

  if (config.preserveCodeBlocks) replaceAll(CODE_FENCE_RE);
  if (config.preserveLatexBlocks) replaceAll(LATEX_BLOCK_RE);

  return { text: out, protectedRegions: regions };
}

/**
 * Expand sentinel tokens back to their original text. Single regex pass per
 * level, so cost is linear in the piece length rather than
 * pieces × regions. Two passes cover the one nesting case: a `$$…$$` block
 * that swallowed a code-fence token (fences are protected first). Tokens
 * that aren't ours (literal PUA text in the source) are left untouched.
 */
function restoreProtected(text: string, byToken: Map<string, string>): string {
  if (byToken.size === 0) return text;
  let out = text;
  for (let pass = 0; pass < 2 && out.includes(PROTECT_OPEN); pass++) {
    // IMPORTANT: String#replace with a string replacement interprets `$$`,
    // `$&`, `$1` etc. as backreferences — which silently eats a `$` from
    // any LaTeX/math source we're restoring. Pass a function instead so
    // the replacement text is used verbatim.
    out = out.replace(PROTECT_TOKEN_RE, (tok) => byToken.get(tok) ?? tok);
  }
  return out;
}

type Measure = (text: string) => number;

/**
 * Length of `text` as it will be after restoreProtected(). Lets the splitter
 * pack pieces by their real size instead of their sentinel size.
 */
function makeRestoredMeasure(regions: Protected[], byToken: Map<string, string>): Measure {
  if (regions.length === 0) return (text) => text.length;
  const extra = new Map<string, number>();
  for (const r of regions) {
    extra.set(r.token, restoreProtected(r.text, byToken).length - r.token.length);
  }
  return (text) => {
    let n = text.length;
    if (!text.includes(PROTECT_OPEN)) return n;
    for (const m of text.matchAll(PROTECT_TOKEN_RE)) n += extra.get(m[0]) ?? 0;
    return n;
  };
}

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

/**
 * Walk the document line-by-line and cut a new section whenever a heading
 * at or above `maxDepth` is encountered. Headings deeper than `maxDepth`
 * are kept inside the enclosing section.
 */
function splitByHeadings(text: string, maxDepth: number): Section[] {
  const lines = text.split(/\r?\n/);
  const sections: Section[] = [];
  let cursor: Section = { heading: null, headingLevel: null, content: '', startLine: 1, endLine: 1 };
  let buf: string[] = [];
  let lineNo = 0;

  const flush = (endLine: number): void => {
    cursor.content = buf.join('\n');
    cursor.endLine = endLine;
    if (cursor.content.trim().length > 0 || cursor.heading) {
      sections.push(cursor);
    }
    buf = [];
  };

  for (const line of lines) {
    lineNo++;
    const m = HEADING_RE.exec(line);
    if (m && m[1].length <= maxDepth) {
      flush(lineNo - 1);
      const level = m[1].length;
      cursor = {
        heading: m[2].trim(),
        headingLevel: level,
        content: '',
        startLine: lineNo,
        endLine: lineNo,
      };
      // The heading line itself is NOT part of the body content — the
      // embedding text is built by prepending `heading` to `content`.
      continue;
    }
    buf.push(line);
  }
  flush(lineNo);
  return sections;
}

/**
 * Recursively split a section's content when it exceeds `chunkSize`.
 * Order of preference: paragraph break → sentence → hard cut. Protected
 * regions (embedded as sentinel tokens) never get split mid-region.
 */
function splitOversize(text: string, config: ChunkerConfig, measure: Measure): string[] {
  if (measure(text) <= config.chunkSize) return [text];

  // Paragraph split.
  const paragraphs = text.split(/\n{2,}/);
  if (paragraphs.length > 1) {
    return packPieces(paragraphs, '\n\n', config, measure);
  }

  // Sentence split. Keep the terminator attached to the preceding sentence.
  const sentences = splitIntoSentences(text);
  if (sentences.length > 1) {
    return packPieces(sentences, ' ', config, measure);
  }

  // Hard cut. Honour protected tokens: don't slice inside one.
  return hardCut(text, config.chunkSize);
}

/**
 * Greedily pack small pieces together until we'd exceed chunkSize, then
 * emit and start the next pack. Each emitted pack that's still too big
 * gets recursively re-split.
 */
function packPieces(
  pieces: string[],
  glue: string,
  config: ChunkerConfig,
  measure: Measure,
): string[] {
  // Any single pack that's still over the limit gets re-split recursively.
  const result: string[] = [];
  for (const chunk of packGreedy(pieces, glue, config.chunkSize, measure)) {
    result.push(...splitOversize(chunk, config, measure));
  }
  return result;
}

/**
 * Greedy packer shared by both split paths. Joins consecutive pieces with
 * `glue` while the measured size stays <= `size`. A single piece that's
 * already over `size` is emitted alone — callers re-split those.
 */
function packGreedy(pieces: string[], glue: string, size: number, measure: Measure): string[] {
  const out: string[] = [];
  let acc = '';
  let accLen = 0;
  for (const piece of pieces) {
    const pieceLen = measure(piece);
    if (acc.length === 0) {
      acc = piece;
      accLen = pieceLen;
    } else if (accLen + glue.length + pieceLen <= size) {
      acc = acc + glue + piece;
      accLen += glue.length + pieceLen;
    } else {
      out.push(acc);
      acc = piece;
      accLen = pieceLen;
    }
  }
  if (acc.length > 0) out.push(acc);
  return out;
}

/**
 * Split levels for already-restored text. Paragraphs first, then lines —
 * code and math are line-oriented, so a line break is a far better cut
 * than the sentence splitter (which would rejoin code lines with spaces).
 */
const RESTORED_SPLIT_LEVELS: ReadonlyArray<{ re: RegExp; glue: string }> = [
  { re: /\n{2,}/, glue: '\n\n' },
  { re: /\n/, glue: '\n' },
];

/**
 * Re-split a restored piece that came out larger than `size` (a protected
 * region bigger than the whole chunk budget). No sentinels remain at this
 * point, so plain lengths are exact. Falls through to hardCut for single
 * lines that are still too long (minified code, base64 blobs).
 */
function splitRestoredOversize(text: string, size: number, level = 0): string[] {
  if (text.length <= size) return [text];
  if (level >= RESTORED_SPLIT_LEVELS.length) return hardCut(text, size);
  const { re, glue } = RESTORED_SPLIT_LEVELS[level];
  const parts = text.split(re);
  const out: string[] = [];
  for (const pack of packGreedy(parts, glue, size, (t) => t.length)) {
    out.push(...splitRestoredOversize(pack, size, level + 1));
  }
  return out;
}

const SENTENCE_RE = /[^.!?]+[.!?]+(\s+|$)/g;

function splitIntoSentences(text: string): string[] {
  const matches = text.match(SENTENCE_RE);
  if (!matches || matches.length === 0) return [text];
  const joined = matches.join('');
  const tail = text.slice(joined.length);
  if (tail.trim().length > 0) matches.push(tail);
  return matches.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Hard cut that avoids splitting a protected-region sentinel token. Walks
 * forward in `chunkSize` steps; if the cut would land inside a sentinel,
 * the cut is nudged so the token stays intact.
 */
function hardCut(text: string, size: number): string[] {
  const out: string[] = [];
  const tokens: Array<{ start: number; end: number }> = [];
  for (const m of text.matchAll(PROTECT_TOKEN_RE)) {
    tokens.push({ start: m.index, end: m.index + m[0].length });
  }

  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + size, text.length);
    for (const tok of tokens) {
      if (tok.start < end && tok.end > end) {
        // Cut would split the token. Prefer moving the cut to just BEFORE
        // the token; if that's already behind `i`, extend to the token end
        // instead so we keep making forward progress.
        end = tok.start > i ? tok.start : tok.end;
      }
    }
    // Don't strand half of a UTF-16 surrogate pair (emoji, rare CJK) at
    // the end of a piece — the lone surrogate is garbage to the tokenizer.
    if (end < text.length && end - 1 > i && isHighSurrogate(text.charCodeAt(end - 1))) {
      end--;
    }
    const piece = text.slice(i, end);
    if (piece.length > 0) out.push(piece);
    i = end;
  }
  return out;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
