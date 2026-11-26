/**
 * Edge `context` is a bounded window around the link occurrence (GitHub
 * issue #39). Hub notes — long link lists with no blank lines, i.e. one
 * giant "paragraph" — used to store the whole paragraph on every edge
 * (13-55 KB each), making `edges` the bulk of the DB and OOM-ing the indexer.
 */
import { describe, it, expect } from 'vitest';
import { parseFileFromContent, buildEdgeContext } from '../../src/vault/parser.js';

const stemLookup = new Map<string, string[]>();
const paths = new Set<string>();

function edgesOf(content: string): Array<{ targetId: string; context: string }> {
  return parseFileFromContent('hub.md', content, stemLookup, paths).edges;
}

/** 2 × radius (150) + link + ellipses; generous ceiling for ordinary links. */
const BOUND = 340;

describe('edge context window', () => {
  it('a hub note with 600 list links stores a small context per edge', () => {
    const lines = Array.from(
      { length: 600 },
      (_, i) => `- [[Topic ${i}]] — summary sentence for topic number ${i} goes here`,
    );
    const content = `# Index\n\n${lines.join('\n')}\n`;
    const edges = edgesOf(content);
    expect(edges).toHaveLength(600);
    let total = 0;
    for (const [i, e] of edges.entries()) {
      expect(e.context.length).toBeLessThanOrEqual(BOUND);
      // The link's own line is in the window, with wiki syntax stripped.
      expect(e.context).toContain(`Topic ${i} — summary sentence for topic number ${i}`);
      expect(e.context).not.toContain(`[[Topic ${i}]]`);
      total += e.context.length;
    }
    // Old behaviour: 600 × ~40 KB. New: well under 1 KB per edge.
    expect(total).toBeLessThan(600 * BOUND);
    // Middle edges are truncated on both sides.
    expect(edges[300]!.context.startsWith('…')).toBe(true);
    expect(edges[300]!.context.endsWith('…')).toBe(true);
  });

  it('keeps a short paragraph whole with no ellipsis', () => {
    const [edge] = edgesOf('Some prose about [[Widget]] and why it matters.');
    expect(edge!.context).toBe('Some prose about Widget and why it matters.');
  });

  it('still drops a trailing [[Target]] (link_notes format)', () => {
    const [edge] = edgesOf('see related note [[Target]]');
    expect(edge!.context).toBe('see related note');
  });

  it('drops a trailing [[Target]] at the end of a long paragraph', () => {
    const [edge] = edgesOf(`${'filler words here '.repeat(40)}\nwhy these connect [[Target]]`);
    expect(edge!.context.startsWith('…')).toBe(true);
    expect(edge!.context.endsWith('why these connect')).toBe(true);
  });

  it('uses the display alias inline', () => {
    const [edge] = edgesOf('We tried [[Widget Theory|the widget idea]] last week.');
    expect(edge!.context).toBe('We tried the widget idea last week.');
  });

  it('cleans every inline occurrence of the target inside a mid-paragraph window', () => {
    // Target appears early; a second, later occurrence sits mid-paragraph.
    const para = `Start [[Target]] ${'word '.repeat(20)}[[Target]] ${'tail '.repeat(100)}`;
    const ctx = buildEdgeContext(para, { raw: 'Target', display: null });
    expect(ctx.startsWith('Start Target')).toBe(true);
    expect(ctx).toContain('word Target tail');
    expect(ctx).not.toContain('[[');
    expect(ctx.endsWith('…')).toBe(true);
  });

  it('never cuts through a neighbouring [[link]]', () => {
    const before = Array.from({ length: 30 }, (_, i) => `[[Neighbour Note ${i}]]`).join(' ');
    const after = Array.from({ length: 30 }, (_, i) => `[[Other Thing ${i}]]`).join(' ');
    const ctx = buildEdgeContext(`${before} [[Target]] ${after}`, { raw: 'Target', display: null });
    expect(ctx).toContain('Target');
    const body = ctx.replace(/^…|…$/g, '');
    // Every `[[` that survives is closed and every `]]` was opened.
    expect((body.match(/\[\[/g) ?? []).length).toBe((body.match(/\]\]/g) ?? []).length);
    expect(body.trim().startsWith('[[')).toBe(true);
    expect(body.trim().endsWith(']]')).toBe(true);
  });

  it('snaps window edges to word boundaries', () => {
    const para = `${'alpha beta gamma '.repeat(20)}[[Target]]${' delta epsilon zeta'.repeat(20)}`;
    const ctx = buildEdgeContext(para, { raw: 'Target', display: null });
    const inner = ctx.slice(1, -1);
    const words = new Set(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'Target']);
    for (const w of inner.trim().split(/\s+/)) expect(words.has(w)).toBe(true);
  });

  it('falls back to a raw cut for text without spaces (CJK)', () => {
    const para = `${'漢字'.repeat(200)}[[Target]]${'かな'.repeat(200)}`;
    const ctx = buildEdgeContext(para, { raw: 'Target', display: null });
    expect(ctx.length).toBeLessThanOrEqual(BOUND);
    expect(ctx).toContain('漢字Targetかな');
  });

  it('hard-caps a pathological multi-KB alias', () => {
    const alias = 'x'.repeat(5000);
    const ctx = buildEdgeContext(`intro [[Target|${alias}]] outro`, { raw: 'Target', display: alias });
    expect(ctx.length).toBeLessThanOrEqual(1001);
    expect(ctx.endsWith('…')).toBe(true);
  });

  it('locates the link via the display text when the bracketed form is absent', () => {
    const para = `${'lead '.repeat(60)}the display words ${'trail '.repeat(60)}`;
    const ctx = buildEdgeContext(para, { raw: 'Hidden', display: 'display words' });
    expect(ctx).toContain('the display words');
    expect(ctx.length).toBeLessThanOrEqual(BOUND);
  });

  it('locates a heading-fragment link by its `[[raw` prefix', () => {
    const para = `${'lead '.repeat(60)}[[Target#Section|shown]] ${'trail '.repeat(60)}`;
    // raw without the fragment: the exact pattern misses, prefix lookup hits.
    const ctx = buildEdgeContext(para, { raw: 'Target', display: null });
    expect(ctx).toContain('[[Target#Section|shown]]');
    expect(ctx.length).toBeLessThanOrEqual(BOUND);
  });

  it('returns an empty string for an empty paragraph', () => {
    expect(buildEdgeContext('', { raw: 'Target', display: null })).toBe('');
  });

  it('starts from the paragraph head when the link text is nowhere in it', () => {
    const ctx = buildEdgeContext('word '.repeat(200), { raw: 'Missing', display: null });
    expect(ctx.startsWith('word')).toBe(true);
    expect(ctx.endsWith('…')).toBe(true);
    expect(ctx.length).toBeLessThanOrEqual(BOUND);
  });
});
