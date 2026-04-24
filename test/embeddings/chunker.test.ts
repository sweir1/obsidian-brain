import { describe, it, expect, afterEach } from 'vitest';
import {
  chunkMarkdown,
  buildChunkEmbeddingText,
  chunkId,
  chunkerConfigFromBudget,
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

// preserveCodeBlocks / preserveLatexBlocks default to true — the opt-out
// arms of the `if (config.preserveCodeBlocks)` / `if (config.preserveLatexBlocks)`
// branches in protectRegions() are untested by default config. These cases
// pin the documented behaviour of the opt-out paths so changes to the
// preserve logic can't silently shift behaviour for callers who disable it.
describe('chunkMarkdown - preserve* opt-out', () => {
  it('preserveCodeBlocks: false allows a code fence to be split across chunks', () => {
    // Build a code fence that's LONGER than chunkSize. With preserve=true
    // (default) the fence is sentinel-protected and stays intact on the hard
    // cut path; with preserve=false the raw text goes through splitOversize
    // normally, so the fence body can land across multiple chunks.
    const fenceBody = 'abc '.repeat(200); // ~800 chars
    const md = `Preamble text.\n\n\`\`\`\n${fenceBody}\n\`\`\`\n`;
    const cfg: ChunkerConfig = {
      ...DEFAULT_CHUNKER_CONFIG,
      chunkSize: 200,
      minChunkChars: 1,
      preserveCodeBlocks: false,
    };
    const chunks = chunkMarkdown(md, cfg);
    // With preserve=false, the fence gets split: we should see MORE chunks
    // than the preserve=true comparison, and no single chunk contains the
    // entire fence body.
    expect(chunks.length).toBeGreaterThan(1);
    const containsWholeFence = chunks.some((c) => c.content.includes(fenceBody.trim()));
    expect(containsWholeFence).toBe(false);
  });

  it('preserveLatexBlocks: false allows $$...$$ to be split', () => {
    const latex = '\\sum_{i=0}^{N} x_i '.repeat(60);
    const md = `Intro paragraph.\n\n$$\n${latex}\n$$\n`;
    const cfg: ChunkerConfig = {
      ...DEFAULT_CHUNKER_CONFIG,
      chunkSize: 200,
      minChunkChars: 1,
      preserveLatexBlocks: false,
    };
    const chunks = chunkMarkdown(md, cfg);
    expect(chunks.length).toBeGreaterThan(1);
    const containsWholeLatex = chunks.some((c) => c.content.includes(latex.trim()));
    expect(containsWholeLatex).toBe(false);
  });

  it('preserveCodeBlocks: true keeps the fence intact (baseline for the opt-out)', () => {
    const fenceBody = 'abc '.repeat(200);
    const md = `Preamble text.\n\n\`\`\`\n${fenceBody}\n\`\`\`\n`;
    const cfg: ChunkerConfig = {
      ...DEFAULT_CHUNKER_CONFIG,
      chunkSize: 200,
      minChunkChars: 1,
      preserveCodeBlocks: true,
    };
    const chunks = chunkMarkdown(md, cfg);
    const containsWholeFence = chunks.some((c) => c.content.includes(fenceBody.trim()));
    expect(containsWholeFence).toBe(true);
  });
});

// Sentence-split path — splitOversize prefers paragraph split, then sentence,
// then hard cut. The sentence path only fires when a section is oversized
// AND has no blank-line paragraph breaks. Pre-v1.6.14 tests only hit the
// paragraph and hard-cut paths.
describe('chunkMarkdown - sentence-split path', () => {
  it('splits a long single-paragraph section on sentence boundaries', () => {
    // No blank-line breaks; only sentence terminators. chunkSize forces split.
    const filler = 'This is sentence number ';
    const sentences = Array.from({ length: 40 }, (_, i) => `${filler}${i}.`).join(' ');
    const cfg: ChunkerConfig = {
      ...DEFAULT_CHUNKER_CONFIG,
      chunkSize: 150,
      minChunkChars: 1,
    };
    const chunks = chunkMarkdown(sentences, cfg);
    expect(chunks.length).toBeGreaterThan(1);
    // Every chunk should end on a sentence boundary (period) — the split
    // preserves the terminator. Trim first so trailing whitespace doesn't
    // confuse the check.
    for (const c of chunks) {
      expect(c.content.trim()).toMatch(/[.!?]$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Capacity-integration tests (chunkerConfigFromBudget + env override)
// ---------------------------------------------------------------------------

describe('chunkerConfigFromBudget', () => {
  it('creates a config with chunkSize equal to the supplied budget', () => {
    const cfg = chunkerConfigFromBudget(3500);
    expect(cfg.chunkSize).toBe(3500);
    // All other fields should equal the defaults.
    expect(cfg.headingSplitDepth).toBe(DEFAULT_CHUNKER_CONFIG.headingSplitDepth);
    expect(cfg.preserveCodeBlocks).toBe(DEFAULT_CHUNKER_CONFIG.preserveCodeBlocks);
    expect(cfg.preserveLatexBlocks).toBe(DEFAULT_CHUNKER_CONFIG.preserveLatexBlocks);
    expect(cfg.minChunkChars).toBe(DEFAULT_CHUNKER_CONFIG.minChunkChars);
  });

  it('respects capacity-provided budget: no chunk exceeds chunkBudgetChars', () => {
    // Budget of 300 chars — all chunks should fit within that.
    const cfg = chunkerConfigFromBudget(300);
    const body = Array.from({ length: 20 }, (_, i) => `Sentence number ${i} ends here.`).join(' ');
    const chunks = chunkMarkdown(`# Heading\n\n${body}`, cfg);
    expect(chunks.length).toBeGreaterThan(0);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(300 + 50); // small tolerance for sentence joins
    }
  });

  it('parent heading is always prepended in buildChunkEmbeddingText output', () => {
    const md =
      '# Getting Started\n\nThis is the intro content for the section. ' +
      'It has enough text to clear the minimum chunk length threshold easily.';
    const [chunk] = chunkMarkdown(md, DEFAULT_CHUNKER_CONFIG);
    expect(chunk).toBeDefined();
    expect(chunk.heading).toBe('Getting Started');
    const embText = buildChunkEmbeddingText(chunk);
    expect(embText.startsWith('Getting Started\n\n')).toBe(true);
    expect(embText).toContain('intro content');
  });

  it('buildChunkEmbeddingText skips empty heading (no heading prepended)', () => {
    const body = 'Preamble with no heading at all, plenty of characters to clear minimum threshold.';
    const [chunk] = chunkMarkdown(body, DEFAULT_CHUNKER_CONFIG);
    // Chunk with no heading — content returned as-is.
    expect(chunk.heading).toBeNull();
    const embText = buildChunkEmbeddingText(chunk);
    expect(embText).toBe(chunk.content);
    expect(embText).not.toMatch(/^\n/);
  });
});

describe('OBSIDIAN_BRAIN_MAX_CHUNK_TOKENS env override (chunker layer)', () => {
  const OLD_ENV = process.env;

  afterEach(() => {
    process.env = OLD_ENV;
  });

  it('env override is respected when passed through chunkerConfigFromBudget', () => {
    // Simulate the pattern callers use: read env → build config → chunk.
    process.env = { ...OLD_ENV, OBSIDIAN_BRAIN_MAX_CHUNK_TOKENS: '200' };
    const envTokens = parseInt(process.env.OBSIDIAN_BRAIN_MAX_CHUNK_TOKENS!, 10);
    // chunkBudgetChars = floor(floor(0.9 * 200) * 2.5) = floor(180 * 2.5) = 450
    const chunkBudgetChars = Math.floor(Math.floor(0.9 * envTokens) * 2.5);
    const cfg = chunkerConfigFromBudget(chunkBudgetChars);
    expect(cfg.chunkSize).toBe(chunkBudgetChars);
    // Confirm the budget is honoured when chunking.
    const body = 'word '.repeat(500);
    const chunks = chunkMarkdown(body, cfg);
    for (const c of chunks) {
      expect(c.content.length).toBeLessThanOrEqual(cfg.chunkSize + 50);
    }
  });
});
