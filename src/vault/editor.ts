/**
 * In-place edits against a single `.md` file inside the vault.
 *
 * Ported from the patch/window-edit logic in aaronsb/obsidian-mcp-plugin
 * (`src/utils/obsidian-api.ts` patchHeading/patchFrontmatter and
 * `src/tools/window-edit.ts`), with these simplifications:
 *   - No Obsidian metadata-cache; heading lookup is a regex over lines.
 *   - No block-id (^blockId) targeting.
 *   - No content-buffer recovery UX; caller handles errors.
 *   - Frontmatter round-trips through gray-matter so YAML structure
 *     (arrays, nested objects) is preserved.
 */

import { promises as fs } from 'fs';
import { join } from 'path';
import matter from 'gray-matter';
import { fuzzyFind } from './fuzzy.js';

export type EditMode =
  | { kind: 'append'; content: string }
  | { kind: 'prepend'; content: string }
  | { kind: 'replace_window'; search: string; content: string; fuzzy?: boolean; fuzzyThreshold?: number }
  | {
      kind: 'patch_heading';
      heading: string;
      content: string;
      op?: 'replace' | 'after' | 'before';
      scope?: 'section' | 'body';
      /**
       * 0-indexed position among matching headings. When the target text
       * appears more than once, `patch_heading` throws MultipleMatchesError
       * unless this is set — pipelines must not silently patch the wrong
       * section. Match order is top-to-bottom by source-file position.
       */
      headingIndex?: number;
    }
  | { kind: 'patch_frontmatter'; key: string; value: unknown }
  | { kind: 'at_line'; line: number; content: string; op?: 'before' | 'after' | 'replace' };

export interface HeadingMatch {
  /** Full matched heading line as it appears in the file. */
  heading: string;
  /** 1-indexed line number of the heading. */
  line: number;
}

/**
 * Thrown by `patch_heading` when the target heading text matches more than
 * one heading and the caller didn't pass `headingIndex` to disambiguate.
 * `matches` lists every occurrence so the caller can pick one.
 */
export class MultipleMatchesError extends Error {
  readonly matches: HeadingMatch[];
  constructor(matches: HeadingMatch[]) {
    const preview = matches.map((m) => `  [${m.line}] ${m.heading}`).join('\n');
    super(
      `[patch_heading] MultipleMatches: ${matches.length} headings match — pass headingIndex (0..${matches.length - 1}) to disambiguate:\n${preview}`,
    );
    this.name = 'MultipleMatchesError';
    this.matches = matches;
  }
}

export interface EditResult {
  path: string;
  bytesWritten: number;
  /**
   * Number of bytes consumed by this edit on the replacement path — i.e. how
   * much pre-existing content was removed before inserting `content`. For
   * insert-only modes (`append`, `prepend`, `at_line` with `op: 'before' |
   * 'after'`) this is always 0. Surfaced specifically so `patch_heading`
   * callers can detect when the default greedy `section` scope consumed more
   * than they expected (e.g. trailing content past a blank line on the last
   * heading).
   */
  removedLen: number;
  diff: { before: string; after: string };
}

const CTX = 500;
export type Apply = { next: string; at: number; len: number; removedLen: number };

function ctx(s: string, at: number, len: number): string {
  const half = Math.floor(CTX / 2);
  return s.slice(Math.max(0, at - half), Math.min(s.length, at + len + half));
}

function lineOffset(lines: string[], idx: number): number {
  let acc = 0;
  for (let i = 0; i < idx; i++) acc += lines[i].length + 1;
  return acc;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function editNote(
  vaultPath: string,
  fileRelPath: string,
  mode: EditMode,
): Promise<EditResult> {
  const abs = join(vaultPath, fileRelPath);
  const original = await fs.readFile(abs, 'utf-8');
  const res = applyEdit(original, mode);

  const tmp = `${abs}.tmp`;
  await fs.writeFile(tmp, res.next, 'utf-8');
  await fs.rename(tmp, abs);

  return {
    path: abs,
    bytesWritten: Buffer.byteLength(res.next, 'utf-8'),
    removedLen: res.removedLen,
    diff: { before: ctx(original, res.at, res.len), after: ctx(res.next, res.at, res.len) },
  };
}

export interface BulkEditResult {
  path: string;
  editsApplied: number;
  bytesWritten: number;
  before: string;
  after: string;
}

export async function bulkEditNote(
  vaultPath: string,
  fileRelPath: string,
  modes: EditMode[],
): Promise<BulkEditResult> {
  const abs = join(vaultPath, fileRelPath);
  const original = await fs.readFile(abs, 'utf-8');

  let current = original;
  for (let i = 0; i < modes.length; i++) {
    try {
      const res = applyEdit(current, modes[i]);
      current = res.next;
    } catch (err) {
      throw new Error(
        `[bulk edit] edits[${i}] (${modes[i].kind}) failed: ${
          err instanceof Error ? err.message : String(err)
        }. No edits were applied.`,
      );
    }
  }

  if (current === original) {
    return {
      path: abs,
      editsApplied: modes.length,
      bytesWritten: 0,
      before: original,
      after: current,
    };
  }

  const tmp = `${abs}.tmp`;
  await fs.writeFile(tmp, current, 'utf-8');
  await fs.rename(tmp, abs);

  return {
    path: abs,
    editsApplied: modes.length,
    bytesWritten: Buffer.byteLength(current, 'utf-8'),
    before: original,
    after: current,
  };
}

export function applyEdit(s: string, mode: EditMode): Apply {
  switch (mode.kind) {
    case 'append': {
      // Defensively ensure the appended content starts on a new line so the
      // last byte of the source file doesn't run into the new content.
      const needsLeadingNewline = s.length > 0 && !s.endsWith('\n');
      const prefix = needsLeadingNewline ? '\n' : '';
      return {
        next: s + prefix + mode.content,
        at: s.length + prefix.length,
        len: mode.content.length,
        removedLen: 0,
      };
    }
    case 'prepend': {
      // If the file starts with a YAML frontmatter block, insert AFTER the
      // closing `---` delimiter so we don't break the fence. Otherwise fall
      // back to position 0.
      const fmMatch = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(s);
      const insertAt = fmMatch ? fmMatch[0].length : 0;
      return {
        next: s.slice(0, insertAt) + mode.content + s.slice(insertAt),
        at: insertAt,
        len: mode.content.length,
        removedLen: 0,
      };
    }
    case 'replace_window':
      return replaceWindow(s, mode.search, mode.content, mode.fuzzy === true, mode.fuzzyThreshold);
    case 'patch_heading':
      return patchHeading(
        s,
        mode.heading,
        mode.content,
        mode.op ?? 'replace',
        mode.scope ?? 'section',
        mode.headingIndex,
      );
    case 'patch_frontmatter':
      return patchFrontmatter(s, mode.key, mode.value);
    case 'at_line':
      return atLine(s, mode.line, mode.content, mode.op ?? 'after');
  }
}

function replaceWindow(s: string, search: string, content: string, fuzzy: boolean, fuzzyThreshold?: number): Apply {
  if (!fuzzy) {
    const first = s.indexOf(search);
    if (first === -1) throw new Error(`[replace_window] NoMatch: search text not found`);
    if (s.indexOf(search, first + search.length) !== -1) {
      throw new Error(`[replace_window] MultipleMatches: exact search matched more than once`);
    }
    return {
      next: s.slice(0, first) + content + s.slice(first + search.length),
      at: first,
      len: content.length,
      removedLen: Buffer.byteLength(search, 'utf-8'),
    };
  }
  const threshold = fuzzyThreshold ?? 0.7;
  const matches = fuzzyFind(s, search, threshold);
  if (matches.length === 0) {
    throw new Error(`[replace_window] NoMatch: needle not found (fuzzy, threshold=${threshold})`);
  }
  if (matches.length > 1) {
    const preview = matches.slice(0, 3)
      .map((m) => `"${m.text.trim().slice(0, 40)}" @${m.start}`)
      .join(', ');
    throw new Error(`[replace_window] MultipleMatches: ${matches.length} candidates near ${preview}`);
  }
  const h = matches[0];
  // When the query has no trailing sentence-terminator but the matched span
  // ended just before one (e.g. query "foo" matched "foo." in the file),
  // swallow that punctuation so the replacement doesn't produce doubles
  // when it already ends in its own terminator.
  let end = h.end;
  const lastQ = search.trim().slice(-1);
  const isTerm = (c: string): boolean => c === '.' || c === '?' || c === '!';
  if (!isTerm(lastQ) && end < s.length && isTerm(s[end])) {
    end += 1;
  }
  return {
    next: s.slice(0, h.start) + content + s.slice(end),
    at: h.start,
    len: content.length,
    removedLen: Buffer.byteLength(s.slice(h.start, end), 'utf-8'),
  };
}

function patchHeading(
  s: string,
  heading: string,
  content: string,
  op: 'replace' | 'after' | 'before',
  scope: 'section' | 'body',
  headingIndex: number | undefined,
): Apply {
  const lines = s.split('\n');
  const re = new RegExp(`^(#+)\\s+${escapeRegex(heading.trim())}\\s*$`);

  const hits: Array<{ idx: number; level: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) hits.push({ idx: i, level: m[1].length, text: lines[i] });
  }
  if (hits.length === 0) {
    throw new Error(`[patch_heading] Heading not found: ${heading}`);
  }
  let picked: { idx: number; level: number };
  if (hits.length === 1) {
    picked = hits[0];
  } else if (headingIndex === undefined) {
    throw new MultipleMatchesError(
      hits.map((h) => ({ heading: h.text, line: h.idx + 1 })),
    );
  } else if (headingIndex < 0 || headingIndex >= hits.length) {
    throw new Error(
      `[patch_heading] headingIndex=${headingIndex} out of range; ${hits.length} matches found (valid: 0..${hits.length - 1})`,
    );
  } else {
    picked = hits[headingIndex];
  }
  const hitIdx = picked.idx;
  const hitLevel = picked.level;

  if (op === 'before') {
    lines.splice(hitIdx, 0, content);
    return {
      next: lines.join('\n'),
      at: lineOffset(lines, hitIdx),
      len: content.length,
      removedLen: 0,
    };
  }
  if (op === 'after') {
    lines.splice(hitIdx + 1, 0, content);
    return {
      next: lines.join('\n'),
      at: lineOffset(lines, hitIdx + 1),
      len: content.length,
      removedLen: 0,
    };
  }

  // 'replace' — compute end of the region we replace.
  // - scope 'section' (default): everything from the heading to the next heading
  //   of <= same level, or EOF. This is the historical behaviour and can be
  //   greedy on the last heading (consumes trailing content that's visually
  //   separate). Callers who want safety pass scope 'body'. `removedLen` in
  //   the result lets callers detect over-consumption.
  // - scope 'body': stop at the first blank line that FOLLOWS content (i.e.
  //   the blank-line boundary after the immediately-following paragraph), or
  //   at the next same-or-higher heading, whichever comes first. Once found,
  //   we extend the range to swallow that boundary blank so the inserted
  //   content's own trailing `\n` provides the separator — otherwise callers
  //   who pass `'new body\n'` get two blank lines between their body and the
  //   next block.
  let endIdx = lines.length;
  if (scope === 'body') {
    let seenContent = false;
    for (let j = hitIdx + 1; j < lines.length; j++) {
      const hm = lines[j].match(/^(#+)\s+/);
      if (hm && hm[1].length <= hitLevel) { endIdx = j; break; }
      const isBlank = lines[j].trim() === '';
      if (!isBlank) seenContent = true;
      if (seenContent && isBlank) { endIdx = j; break; }
    }
    // Eat the trailing blank so we don't produce a double blank on replace.
    if (endIdx < lines.length && lines[endIdx].trim() === '') {
      endIdx += 1;
    }
  } else {
    for (let j = hitIdx + 1; j < lines.length; j++) {
      const hm = lines[j].match(/^(#+)\s+/);
      if (hm && hm[1].length <= hitLevel) { endIdx = j; break; }
    }
  }

  // Preserve the blank line immediately after the heading when one exists
  // in the original. `# H\n\nold\n` patched → `# H\n\nnew\n`, not
  // `# H\nnew\n`. When the original has no blank, we don't inject one —
  // existing tests (and the Obsidian community-varied convention) expect
  // `# H\nbody` to round-trip as `# H\nnew body`.
  let contentStart = hitIdx + 1;
  if (contentStart < lines.length && lines[contentStart].trim() === '' && contentStart < endIdx) {
    contentStart++;
  }

  // Capture the byte length of the region we're about to remove, for the
  // `removedLen` field on the result. `lineOffset` totals length + newline
  // per line; we compute the same way so the two halves agree.
  const removedText = lines.slice(contentStart, endIdx).join('\n');
  // If the last removed line was the final line of the file (no trailing
  // newline after it), we still join with '\n' which is slightly high by one
  // only when the original file ended mid-line; for typical `.md` files that
  // always end with `\n`, this is exact.
  const removedLen = Buffer.byteLength(removedText, 'utf-8');

  lines.splice(contentStart, endIdx - contentStart, content);
  return {
    next: lines.join('\n'),
    at: lineOffset(lines, contentStart),
    len: content.length,
    removedLen,
  };
}

function patchFrontmatter(s: string, key: string, value: unknown): Apply {
  const parsed = matter(s);
  const data = { ...(parsed.data as Record<string, unknown>) };
  if (value === null || value === undefined) delete data[key];
  else data[key] = value;
  const next = matter.stringify(parsed.content, data);
  const at = Math.max(0, next.indexOf(`${key}:`));
  // Frontmatter rewrites round-trip through gray-matter so `removedLen` isn't
  // meaningfully defined (the YAML block may be completely re-serialised).
  // Reporting 0 keeps the shape valid without lying about byte counts.
  return { next, at, len: String(value ?? '').length, removedLen: 0 };
}

function atLine(
  s: string,
  line: number,
  content: string,
  op: 'before' | 'after' | 'replace',
): Apply {
  const lines = s.split('\n');
  if (line < 1 || line > lines.length + 1) {
    throw new Error(`[at_line] Invalid line ${line}; file has ${lines.length} lines`);
  }
  const idx = line - 1;
  if (op === 'replace') {
    const removedLen = Buffer.byteLength(lines[idx] ?? '', 'utf-8');
    lines[idx] = content;
    return {
      next: lines.join('\n'),
      at: lineOffset(lines, idx),
      len: content.length,
      removedLen,
    };
  }
  if (op === 'before') {
    lines.splice(idx, 0, content);
    return {
      next: lines.join('\n'),
      at: lineOffset(lines, idx),
      len: content.length,
      removedLen: 0,
    };
  }
  lines.splice(idx + 1, 0, content);
  return {
    next: lines.join('\n'),
    at: lineOffset(lines, idx + 1),
    len: content.length,
    removedLen: 0,
  };
}
