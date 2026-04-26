import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Doc-drift invariant: no obsidian-brain self-version refs in user-facing
 * docs prose. Phrases like "since v1.4.0" / "added in v1.7.0" / "as of v1.6.5"
 * rot the moment a feature ships further back than the doc remembers.
 *
 * Allowed: CHANGELOG (the version history), roadmap (forward-looking),
 * migration-aaronsb.md (cross-references a different project's versions).
 *
 * External dependency contracts ("Obsidian ≥ 1.10.0", "plugin v0.2.0+",
 * "Node ≥ 20") stay — those ARE the contract users need to satisfy. The
 * regex below specifically matches *temporal* version refs ("since/in/as of
 * vX.Y.Z"), not contract refs.
 *
 * Mirrors the grep recipe documented in RELEASING.md (lines ~60–63), elevated
 * here to a CI-blocking test.
 */
describe('no obsidian-brain version refs in non-CHANGELOG docs prose', () => {
  const ALLOWLIST = new Set([
    'docs/CHANGELOG.md',
    'docs/roadmap.md',
    'docs/migration-aaronsb.md',
  ]);

  // Match phrases like "since v1.4.0", "added in v1.7", "as of v1.6.5".
  const VERSION_REF_RE = /\b(since|in|as of|added in)\s+v\d+\.\d+(\.\d+)?\b/gi;

  it('every doc/*.md outside the allowlist has zero temporal-version refs', () => {
    const violations: Array<{ file: string; matches: string[] }> = [];
    for (const entry of readdirSync('docs', { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
      const path = `docs/${entry.name}`;
      if (ALLOWLIST.has(path)) continue;

      const text = readFileSync(path, 'utf8');
      const matches = [...text.matchAll(VERSION_REF_RE)].map((m) => m[0]);
      if (matches.length > 0) violations.push({ file: path, matches });
    }
    expect(
      violations,
      `Self-version refs in docs prose:\n` +
        violations
          .map((v) => `  ${v.file}: ${v.matches.join(', ')}`)
          .join('\n'),
    ).toEqual([]);
  });
});

/**
 * Source-strings invariant: no obsidian-brain self-version refs leaking into
 * user-facing strings (tool descriptions, stderr messages, CLI help, error
 * messages). Same rationale as the docs version of this test — phrases like
 * "v1.4.0 upgrade" or "first v1.5.1 boot" rot the moment we ship far enough
 * past those versions that a user reading them is confused about why the
 * messages reference releases they never used.
 *
 * The pattern matches any self-version ref of obsidian-brain (vX.Y or vX.Y.Z)
 * inside string literals. External-package version contracts (e.g. "Obsidian
 * 1.10.0+", "Node ≥ 20") don't have a leading `v` so they don't trigger.
 *
 * Allowlist:
 *   - test/ files (regression tests for this very issue NEED to grep for
 *     the bad patterns).
 *   - Anywhere outside src/.
 */
describe('no obsidian-brain version refs in user-facing source strings', () => {
  // Match a self-version ref like "v1.4.0" that's NOT inside a hyphenated
  // identifier (so model names like `bge-small-en-v1.5` don't match — those
  // are HF model identifiers, not obsidian-brain versions). The negative
  // lookbehind excludes word-chars and hyphens immediately before `v`.
  const SRC_VERSION_RE = /(?<![\w-])v\d+\.\d+(?:\.\d+)?\b/g;

  // Files where vX.Y.Z legitimately refers to a different package (companion
  // plugin compat, dataview plugin compat) or to internal SQL DDL comments
  // that never reach user-facing output.
  const SRC_ALLOWLIST = new Set([
    'src/obsidian/client.ts',       // companion-plugin / dataview-plugin compat refs
    'src/tools/dataview-query.ts',  // dataview-plugin v0.2.0+ compat in tool description
    'src/store/db.ts',              // internal SQL DDL comments inside CREATE TABLE strings
  ]);

  function* walkTs(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        yield* walkTs(path);
      } else if (entry.isFile() && entry.name.endsWith('.ts')) {
        yield path;
      }
    }
  }

  // Scan only string-literal content, not comments. We do this with a simple
  // tokenizer pass — match single, double, and template literals — then run
  // the version regex against the concatenated string-literal payload.
  function extractStringLiterals(source: string): string {
    let out = '';
    let i = 0;
    while (i < source.length) {
      const ch = source[i];
      if (ch === '/' && source[i + 1] === '/') {
        // line comment
        const end = source.indexOf('\n', i);
        i = end === -1 ? source.length : end;
      } else if (ch === '/' && source[i + 1] === '*') {
        // block comment
        const end = source.indexOf('*/', i + 2);
        i = end === -1 ? source.length : end + 2;
      } else if (ch === '"' || ch === "'" || ch === '`') {
        const quote = ch;
        i++;
        while (i < source.length && source[i] !== quote) {
          if (source[i] === '\\') {
            i += 2;
            continue;
          }
          out += source[i];
          i++;
        }
        out += '\n';
        i++; // skip closing quote
      } else {
        i++;
      }
    }
    return out;
  }

  it('no vX.Y(.Z) self-version refs in src/**/*.ts string literals', () => {
    const violations: Array<{ file: string; matches: string[] }> = [];
    for (const file of walkTs('src')) {
      if (!statSync(file).isFile()) continue;
      if (SRC_ALLOWLIST.has(file)) continue;
      const source = readFileSync(file, 'utf8');
      const literals = extractStringLiterals(source);
      const matches = [...literals.matchAll(SRC_VERSION_RE)].map((m) => m[0]);
      if (matches.length > 0) violations.push({ file, matches: [...new Set(matches)] });
    }
    expect(
      violations,
      `Self-version refs in src/ string literals:\n` +
        violations
          .map((v) => `  ${v.file}: ${v.matches.join(', ')}`)
          .join('\n'),
    ).toEqual([]);
  });
});
