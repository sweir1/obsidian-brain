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
  | { kind: 'replace_window'; search: string; content: string; fuzzy?: boolean }
  | {
      kind: 'patch_heading';
      heading: string;
      content: string;
      op?: 'replace' | 'after' | 'before';
      scope?: 'section' | 'body';
    }
  | { kind: 'patch_frontmatter'; key: string; value: unknown }
  | { kind: 'at_line'; line: number; content: string; op?: 'before' | 'after' | 'replace' };

export interface EditResult {
  path: string;
  bytesWritten: number;
  diff: { before: string; after: string };
}

const CTX = 500;
type Apply = { next: string; at: number; len: number };

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
    diff: { before: ctx(original, res.at, res.len), after: ctx(res.next, res.at, res.len) },
  };
}

function applyEdit(s: string, mode: EditMode): Apply {
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
      };
    }
    case 'replace_window':
      return replaceWindow(s, mode.search, mode.content, mode.fuzzy === true);
    case 'patch_heading':
      return patchHeading(
        s,
        mode.heading,
        mode.content,
        mode.op ?? 'replace',
        mode.scope ?? 'section',
      );
    case 'patch_frontmatter':
      return patchFrontmatter(s, mode.key, mode.value);
    case 'at_line':
      return atLine(s, mode.line, mode.content, mode.op ?? 'after');
  }
}

function replaceWindow(s: string, search: string, content: string, fuzzy: boolean): Apply {
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
    };
  }
  const matches = fuzzyFind(s, search, 0.7);
  if (matches.length === 0) {
    throw new Error(`[replace_window] NoMatch: needle not found (fuzzy, threshold=0.7)`);
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
  };
}

function patchHeading(
  s: string,
  heading: string,
  content: string,
  op: 'replace' | 'after' | 'before',
  scope: 'section' | 'body',
): Apply {
  const lines = s.split('\n');
  const re = new RegExp(`^(#+)\\s+${escapeRegex(heading.trim())}\\s*$`);

  let hitIdx = -1;
  let hitLevel = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m) { hitIdx = i; hitLevel = m[1].length; break; }
  }
  if (hitIdx === -1) throw new Error(`[patch_heading] Heading not found: ${heading}`);

  if (op === 'before') {
    lines.splice(hitIdx, 0, content);
    return { next: lines.join('\n'), at: lineOffset(lines, hitIdx), len: content.length };
  }
  if (op === 'after') {
    lines.splice(hitIdx + 1, 0, content);
    return { next: lines.join('\n'), at: lineOffset(lines, hitIdx + 1), len: content.length };
  }

  // 'replace' — compute end of the region we replace.
  // - scope 'section' (default): everything from the heading to the next heading
  //   of <= same level, or EOF. This is the historical behaviour and can be
  //   greedy on the last heading (consumes trailing content that's visually
  //   separate). Callers who want safety pass scope 'body'.
  // - scope 'body': stop at the first blank line that FOLLOWS content (i.e.
  //   the blank-line boundary after the immediately-following paragraph), or
  //   at the next same-or-higher heading, whichever comes first.
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
  } else {
    for (let j = hitIdx + 1; j < lines.length; j++) {
      const hm = lines[j].match(/^(#+)\s+/);
      if (hm && hm[1].length <= hitLevel) { endIdx = j; break; }
    }
  }

  // Preserve the blank line immediately after the heading when one is present.
  // `# H\n\nold\n` patched → `# H\n\nnew\n`, not `# H\nnew\n`.
  let contentStart = hitIdx + 1;
  if (contentStart < lines.length && lines[contentStart].trim() === '' && contentStart < endIdx) {
    contentStart++;
  }

  lines.splice(contentStart, endIdx - contentStart, content);
  return { next: lines.join('\n'), at: lineOffset(lines, contentStart), len: content.length };
}

function patchFrontmatter(s: string, key: string, value: unknown): Apply {
  const parsed = matter(s);
  const data = { ...(parsed.data as Record<string, unknown>) };
  if (value === null || value === undefined) delete data[key];
  else data[key] = value;
  const next = matter.stringify(parsed.content, data);
  const at = Math.max(0, next.indexOf(`${key}:`));
  return { next, at, len: String(value ?? '').length };
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
    lines[idx] = content;
    return { next: lines.join('\n'), at: lineOffset(lines, idx), len: content.length };
  }
  if (op === 'before') {
    lines.splice(idx, 0, content);
    return { next: lines.join('\n'), at: lineOffset(lines, idx), len: content.length };
  }
  lines.splice(idx + 1, 0, content);
  return { next: lines.join('\n'), at: lineOffset(lines, idx + 1), len: content.length };
}
