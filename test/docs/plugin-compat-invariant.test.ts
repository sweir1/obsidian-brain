import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Doc-drift invariant: no doc states a hardcoded companion-plugin version
 * minimum like "plugin v1.4.0+" or "plugin ≥ 0.2.0" in user-facing prose.
 *
 * The actual contract is **same major.minor**: server v1.X.Y pairs with
 * plugin v1.X.Z. Capability-gated tools reject specific routes via the
 * discovery file's `capabilities` array — that's the runtime check —
 * NOT a version pin in the docs.
 *
 * Why this catches drift: docs/plugin.md, docs/jan.md, docs/architecture.md,
 * and docs/tools.md historically each carried different pinned versions
 * (`v0.1.0+`, `v0.2.0+`, `v1.4.0+`, `v1.6.0`) that all rotted at different
 * speeds. The same major.minor rule is the only durable contract.
 *
 * External dep contracts ("Obsidian ≥ 1.10.0") are NOT plugin-version refs
 * and are permitted by the regex (which anchors on the word "plugin").
 *
 * Allowed contexts: CHANGELOG (history), troubleshooting historical sections
 * (e.g., "calling against a v0.1.x plugin returned…" describing a legacy
 * error). Allowlist-based.
 */
describe('no hardcoded companion-plugin version refs in user-facing docs', () => {
  const FILES = [
    'README.md',
    'docs/plugin.md',
    'docs/jan.md',
    'docs/tools.md',
    'docs/architecture.md',
  ];

  // Match a hardcoded plugin version pin: "plugin v1.4.0", "plugin ≥ 0.2.0",
  // "plugin v1.6.0+". Negative-lookahead `(?!\.x)` skips "plugin v1.7.x" — the
  // major.minor rule wording the user explicitly chose.
  const PLUGIN_VERSION_PIN_RE = /\bplugin\s+(?:v|≥\s*)?\d+\.\d+(?:\.\d+)?(?:\+)?\b(?!\.x)/gi;

  // Phrases referencing past plugin versions in narrative / troubleshooting
  // context, NOT as a contract claim. Allowlist literal lowercase-trimmed
  // matches so historical "plugin v0.1.x" references survive.
  const ALLOWED_LITERALS = new Set<string>([
    'plugin v0.1.x',
    'plugin is v0.1.x',
  ]);

  it.each(FILES)('%s contains no hardcoded plugin version pins', (path) => {
    const text = readFileSync(path, 'utf8');
    const matches = [...text.matchAll(PLUGIN_VERSION_PIN_RE)].map((m) => m[0]);
    const reallyBad = matches.filter((m) => {
      const norm = m.toLowerCase().trim();
      if (ALLOWED_LITERALS.has(norm)) return false;
      // Allow "plugin vN.N.x" rule wording (defensive — regex should already
      // skip these, but a literal-string check covers any weird formatting).
      if (/\bplugin\s+v?\d+\.\d+\.x\b/i.test(m)) return false;
      return true;
    });
    expect(
      reallyBad,
      `${path} has hardcoded plugin version pins: ${reallyBad.join(', ')}`,
    ).toEqual([]);
  });
});
