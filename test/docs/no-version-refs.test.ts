import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

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
