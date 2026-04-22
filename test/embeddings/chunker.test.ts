import { describe, it, expect } from 'vitest';
import {
  chunkMarkdown,
  buildChunkEmbeddingText,
  chunkId,
  DEFAULT_CHUNKER_CONFIG,
  type ChunkerConfig,
} from '../../src/embeddings/chunker.js';

const SMALL: ChunkerConfig = { ...DEFAULT_CHUNKER_CONFIG, chunkSize: 120, minChunkChars: 1 };

describe('chunkMarkdown', () => {
  it('returns empty array for empty input', () => {
    expect(chunkMarkdown('', DEFAULT_CHUNKER_CONFIG)).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    expect(chunkMarkdown('   \n\n  ', DEFAULT_CHUNKER_CONFIG)).toEqual([]);
  });

  it('strips YAML frontmatter before chunking', () => {
    const md = [
      '---',
      'title: Foo',
      'tags: [a, b]',
      '---',
      '',
      '# Real Heading',
      '',
      'Some body text. ' + 'Padding '.repeat(20),
    ].join('\n');
    const chunks = chunkMarkdown(md, DEFAULT_CHUNKER_CONFIG);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.content).not.toContain('title: Foo');
      expect(c.content).not.toContain('tags:');
    }
  });

  it('splits on markdown headings', () => {
    const filler = 'Some padding text to clear the minimum length threshold.';
    const md = [
      '# Alpha',
      `First section body. ${filler}`,
      '',
      '# Beta',
      `Second section body. ${filler}`,
      '',
      '# Gamma',
      `Third section body. ${filler}`,
    ].join('\n');
    const chunks = chunkMarkdown(md, DEFAULT_CHUNKER_CONFIG);
    const headings = chunks.map((c) => c.heading);
    expect(headings).toContain('Alpha');
    expect(headings).toContain('Beta');
    expect(headings).toContain('Gamma');
  });

  it('respects headingSplitDepth (headings below the depth stay in the parent section)', () => {
    const filler = 'padding padding padding padding padding padding padding';
    const md = [
      '# H1',
      `body one ${filler}`,
      '',
      '##### H5 should not split',
      `body two ${filler}`,
    ].join('\n');
    const chunks = chunkMarkdown(md, { ...DEFAULT_CHUNKER_CONFIG, headingSplitDepth: 4 });
    // Exactly one chunk, under "H1".
    expect(chunks.length).toBe(1);
    expect(chunks[0].heading).toBe('H1');
  });

  it('splits an oversized section on paragraph breaks', () => {
    const big = Array.from({ length: 8 }, (_, i) => `Paragraph ${i} ${'x'.repeat(40)}`).join('\n\n');
    const md = `# Big\n\n${big}`;
    const chunks = chunkMarkdown(md, SMALL);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.content.length).toBeLessThanOrEqual(SMALL.chunkSize + 20);
  });

  it('preserves code blocks intact across the split', () => {
    const fence = '```js\n' + 'console.log("hi");\n'.repeat(6) + '```';
    const md = `# With Code\n\nprefix para.\n\n${fence}\n\nsuffix para.`;
    const chunks = chunkMarkdown(md, SMALL);
    const joined = chunks.map((c) => c.content).join('\n\n');
    // The entire fence appears exactly once in the output, unsplit.
    expect(joined).toContain(fence);
    const fenceCount = (joined.match(/```js/g) ?? []).length;
    expect(fenceCount).toBe(1);
  });

  it('preserves latex blocks intact across the split', () => {
    const latex = '$$\n' + '\\int_{0}^{1} x^2 dx\n'.repeat(6) + '$$';
    const md = `# Math\n\nsome intro.\n\n${latex}\n\nafterwards.`;
    const chunks = chunkMarkdown(md, SMALL);
    const joined = chunks.map((c) => c.content).join('\n\n');
    expect(joined).toContain(latex);
  });

  it('each chunk has a stable contentHash', () => {
    const md = '# One\n\nBody content with enough text to clear the minimum chunk length threshold.';
    const a = chunkMarkdown(md, DEFAULT_CHUNKER_CONFIG);
    const b = chunkMarkdown(md, DEFAULT_CHUNKER_CONFIG);
    expect(a.length).toBeGreaterThan(0);
    expect(a[0].contentHash).toBe(b[0].contentHash);
  });

  it('different content produces different contentHash', () => {
    const pad = ' lots of extra characters here so we clear the minimum length threshold.';
    const a = chunkMarkdown(`# A\n\nalpha body${pad}`, DEFAULT_CHUNKER_CONFIG);
    const b = chunkMarkdown(`# A\n\nbeta body${pad}`, DEFAULT_CHUNKER_CONFIG);
    expect(a[0].contentHash).not.toBe(b[0].contentHash);
  });

  it('chunkIndex is sequential and zero-based', () => {
    const filler = 'padding padding padding padding padding padding';
    const md = [
      '# One', `body one ${filler}`,
      '',
      '# Two', `body two ${filler}`,
      '',
      '# Three', `body three ${filler}`,
    ].join('\n');
    const chunks = chunkMarkdown(md, DEFAULT_CHUNKER_CONFIG);
    expect(chunks.map((c) => c.chunkIndex)).toEqual([0, 1, 2]);
  });

  it('drops chunks shorter than minChunkChars', () => {
    const md = '# Big enough\n\n' + 'x'.repeat(200) + '\n\n# Too short\n\nhi';
    const chunks = chunkMarkdown(md, { ...DEFAULT_CHUNKER_CONFIG, minChunkChars: 100 });
    const headings = chunks.map((c) => c.heading);
    expect(headings).toContain('Big enough');
    expect(headings).not.toContain('Too short');
  });
});

describe('buildChunkEmbeddingText', () => {
  it('prepends the heading when present', () => {
    const [chunk] = chunkMarkdown(
      '# Widget Theory\n\nBody talks about widgets at considerable length with plenty of filler text.',
      DEFAULT_CHUNKER_CONFIG,
    );
    const text = buildChunkEmbeddingText(chunk);
    expect(text.startsWith('Widget Theory')).toBe(true);
    expect(text).toContain('Body talks about widgets');
  });

  it('returns content alone when heading is missing', () => {
    const body = 'Just body text with no heading at all, long enough to clear the minimum length threshold.';
    const [chunk] = chunkMarkdown(body, DEFAULT_CHUNKER_CONFIG);
    const text = buildChunkEmbeddingText(chunk);
    expect(text).toBe(chunk.content);
  });
});

describe('chunkId', () => {
  it('joins node id and index with `::`', () => {
    expect(chunkId('Notes/foo.md', 3)).toBe('Notes/foo.md::3');
  });
});
