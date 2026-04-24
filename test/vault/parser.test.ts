import { describe, it, expect, vi } from 'vitest';
import { join } from 'node:path';
import { parseVault, parseFileFromContent } from '../../src/vault/parser.js';

const FIXTURE_VAULT = join(import.meta.dirname, '..', 'fixtures', 'vault');

describe('parseVault', () => {
  it('finds all .md files and skips excluded directories', async () => {
    const { nodes } = await parseVault(FIXTURE_VAULT);
    const ids = nodes.map((n) => n.id);
    expect(ids).toContain('People/Alice Smith.md');
    expect(ids).toContain('People/Bob Jones.md');
    expect(ids).toContain('Concepts/Widget Theory.md');
    expect(ids).toContain('orphan.md');
    // Should NOT include .obsidian or attachments
    expect(ids.every((id) => !id.startsWith('.obsidian/'))).toBe(true);
    expect(ids.every((id) => !id.startsWith('attachments/'))).toBe(true);
  });

  it('parses frontmatter correctly', async () => {
    const { nodes } = await parseVault(FIXTURE_VAULT);
    const alice = nodes.find((n) => n.id === 'People/Alice Smith.md')!;
    expect(alice.title).toBe('Alice Smith');
    expect(alice.frontmatter.type).toBe('person');
    expect(alice.frontmatter.aliases).toContain('A. Smith');
  });

  it('falls back to filename when no title in frontmatter', async () => {
    const { nodes } = await parseVault(FIXTURE_VAULT);
    const noTitle = nodes.find((n) => n.id === 'no-title.md')!;
    expect(noTitle.title).toBe('no-title');
  });

  it('extracts resolved edges with context', async () => {
    const { edges } = await parseVault(FIXTURE_VAULT);
    const aliceToWidget = edges.find(
      (e) =>
        e.sourceId === 'People/Alice Smith.md' &&
        e.targetId === 'Concepts/Widget Theory.md',
    );
    expect(aliceToWidget).toBeDefined();
    expect(aliceToWidget!.context).toContain('Widget Theory');
  });

  it('creates stub edges for nonexistent targets', async () => {
    const { edges, stubIds } = await parseVault(FIXTURE_VAULT);
    const stubEdge = edges.find((e) => e.targetId.includes('Nonexistent Page'));
    expect(stubEdge).toBeDefined();
    expect(stubIds.size).toBeGreaterThan(0);
  });

  it('extracts inline tags', async () => {
    const { nodes } = await parseVault(FIXTURE_VAULT);
    const bob = nodes.find((n) => n.id === 'People/Bob Jones.md')!;
    expect(bob.frontmatter.inline_tags).toContain('research');
    expect(bob.frontmatter.inline_tags).toContain('published');
  });
});

describe('parseFileFromContent inline Dataview fields', () => {
  const empty = {
    stemLookup: new Map<string, string[]>(),
    paths: new Set<string>(),
  };

  it('parses `key:: value` lines into frontmatter', () => {
    const raw = [
      '---',
      'title: Example',
      '---',
      '',
      'status:: reading',
      'priority:: high',
      '',
      'Some body text.',
    ].join('\n');
    const { node } = parseFileFromContent(
      'Example.md',
      raw,
      empty.stemLookup,
      empty.paths,
    );
    expect(node.frontmatter.status).toBe('reading');
    expect(node.frontmatter.priority).toBe('high');
  });

  it('ignores `::` inside fenced code blocks', () => {
    const raw = [
      '# Title',
      '',
      '```ts',
      'const x:: number = 1;',
      '```',
      '',
      'real:: field',
    ].join('\n');
    const { node } = parseFileFromContent(
      'Example.md',
      raw,
      empty.stemLookup,
      empty.paths,
    );
    expect(node.frontmatter.real).toBe('field');
    expect(node.frontmatter.x).toBeUndefined();
  });

  it('does not override explicit YAML frontmatter', () => {
    const raw = [
      '---',
      'status: done',
      '---',
      '',
      'status:: reading',
    ].join('\n');
    const { node } = parseFileFromContent(
      'Example.md',
      raw,
      empty.stemLookup,
      empty.paths,
    );
    // YAML frontmatter wins — matter() is merged first, inline fields spread after,
    // but duplicate inline writes skip existing keys so YAML `status` survives.
    expect(node.frontmatter.status).toBe('done');
  });
});

// parseFileFromContent has a try/catch that swallows gray-matter's YAML parse
// errors and falls back to treating the whole file as plain markdown. Before
// this test, that fallback was exercised by zero test cases — meaning a
// silent regression could mis-index every note with tricky frontmatter. These
// tests lock in the graceful-fallback contract and verify the observable
// signals (title falls back to filename, console.warn fires, content preserved).
//
// Empirical note on what triggers gray-matter to throw: unclosed frontmatter
// (missing terminating `---`) throws and trips the fallback. Tab-indented
// YAML and a few other "technically invalid" patterns parse successfully via
// js-yaml's lenient mode. So the fallback's real job is defending against
// structurally broken files, not every YAML-spec violation.
describe('parseFileFromContent malformed frontmatter fallback', () => {
  const empty = {
    stemLookup: new Map<string, string[]>(),
    paths: new Set<string>(),
  };

  it('unclosed frontmatter (no terminating ---) falls back to plain markdown', () => {
    const raw = '---\ntitle: unclosed\nBody with no closing marker\n';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { node } = parseFileFromContent(
        'Example.md',
        raw,
        empty.stemLookup,
        empty.paths,
      );
      // Title falls back to the filename stem — the YAML `title: unclosed`
      // never gets parsed because the whole block failed.
      expect(node.title).toBe('Example');
      // Content keeps the raw text so downstream tokenizers see SOMETHING.
      expect(node.content).toContain('Body with no closing marker');
      // The warn is the observable signal for operators: if a vault starts
      // producing these in bulk, something upstream is writing broken files.
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Malformed frontmatter in Example.md'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('edges are still extracted when frontmatter parse fails', () => {
    const raw = '---\ntitle: unclosed\nSee [[Target]] for details.\n';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { edges } = parseFileFromContent(
        'Example.md',
        raw,
        empty.stemLookup,
        empty.paths,
      );
      // The [[Target]] edge must still land — losing edges silently on
      // malformed-fm files would corrupt the graph without any error signal.
      expect(edges.some((e) => e.targetId.includes('Target'))).toBe(true);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('valid but unusually-formatted YAML still parses cleanly (no false positives)', () => {
    // Tab indentation passes gray-matter — js-yaml is lenient by default.
    // This test pins that behaviour so no one "fixes" the parser to throw
    // on tabs and mass-trigger the fallback on existing well-formed vaults.
    const raw = [
      '---',
      'title: Test',
      'nested:',
      '\tvalue: ok', // tab; js-yaml parses this fine
      '---',
      '',
      'Body.',
    ].join('\n');
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { node } = parseFileFromContent(
        'Example.md',
        raw,
        empty.stemLookup,
        empty.paths,
      );
      expect(node.title).toBe('Test');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
