import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * Doc-drift invariant: docs/tools.md must list exactly the tools registered
 * in src/tools/. Catches the kind of drift where a new tool was added in
 * source but not surfaced in the docs (or removed from source but still
 * documented).
 *
 * The shared-infra files (`register.ts`, `preview-store.ts`, `hints.ts`,
 * `edit-buffer.ts`, `background-reindex.ts`) are not MCP tools — they're
 * helpers used by the actual tool handlers — and are excluded.
 */
describe('docs/tools.md vs src/tools/ — drift invariant', () => {
  const SHARED_INFRA = new Set([
    'register',
    'preview-store',
    'hints',
    'edit-buffer',
    'background-reindex',
  ]);

  it('docs/tools.md headings match every registered MCP tool, no extras, no omissions', () => {
    const sourceTools = readdirSync('src/tools', { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.ts'))
      .map((d) => d.name.replace(/\.ts$/, ''))
      .filter((n) => !SHARED_INFRA.has(n))
      .map((n) => n.replace(/-/g, '_'))
      .sort();

    const md = readFileSync('docs/tools.md', 'utf8');
    const docTools = [...md.matchAll(/^### `([a-z_]+)`/gm)].map((m) => m[1]).sort();

    expect(new Set(docTools), 'docs/tools.md tool list drifted from src/tools/').toEqual(
      new Set(sourceTools),
    );
  });

  it('docs/tools.md frontmatter description count matches the actual tool count', () => {
    const sourceCount = readdirSync('src/tools', { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.endsWith('.ts'))
      .map((d) => d.name.replace(/\.ts$/, ''))
      .filter((n) => !SHARED_INFRA.has(n)).length;

    const md = readFileSync('docs/tools.md', 'utf8');
    const m = md.match(/All (\d+) MCP tools/);
    expect(m, 'docs/tools.md frontmatter must claim a tool count').not.toBeNull();
    expect(parseInt(m![1], 10), 'docs/tools.md frontmatter tool count drifted').toBe(sourceCount);
  });
});
