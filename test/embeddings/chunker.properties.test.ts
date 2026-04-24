import { describe, it } from 'vitest';
import fc from 'fast-check';
import {
  chunkMarkdown,
  DEFAULT_CHUNKER_CONFIG,
  type ChunkerConfig,
} from '../../src/embeddings/chunker.js';

// Property-based tests — the pilot case for fast-check in this codebase.
//
// Example-based tests lock in specific behaviours we've already thought of;
// property-based tests generate many random inputs and check invariants that
// MUST hold regardless of shape. Chunker was picked for the pilot because its
// sentinel protect/restore cycle and hard-cut collision avoidance have many
// subtle failure modes you can't anticipate with hand-written cases.
//
// numRuns: 200 — large enough to explore the space meaningfully, small enough
// that the whole file adds single-digit seconds to `npm run test`.

// ---- Generators -----------------------------------------------------------

/** Bounded natural-text string — arbitrary Unicode is too noisy for markdown. */
const textArb = fc.string({ minLength: 0, maxLength: 200 }).filter(
  // Disallow control chars that markdown parsers mangle, plus literal
  // fence/math open sequences (those are generated deliberately below).
  (s) => !/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(s) && !s.includes('```') && !s.includes('$$'),
);

/** A markdown paragraph (single or multi-line). */
const paragraphArb = fc.array(textArb, { minLength: 1, maxLength: 4 })
  .map((lines) => lines.join('\n'));

/** A code fence block whose body is arbitrary text (no backticks). */
const fenceArb = fc.string({ minLength: 0, maxLength: 120 })
  .filter((s) => !s.includes('```'))
  .map((body) => '```\n' + body + '\n```');

/** A LaTeX $$...$$ block whose body is arbitrary text (no `$$`). */
const latexArb = fc.string({ minLength: 0, maxLength: 80 })
  .filter((s) => !s.includes('$$'))
  .map((body) => '$$\n' + body + '\n$$');

/** A heading line at level 1-4. */
const headingArb = fc.tuple(
  fc.integer({ min: 1, max: 4 }),
  textArb.filter((s) => s.trim().length > 0 && !s.includes('\n')),
).map(([level, text]) => '#'.repeat(level) + ' ' + text.trim());

/** A full-document arbitrary: interleaved paragraphs, fences, latex, headings. */
const documentArb = fc.array(
  fc.oneof(paragraphArb, fenceArb, latexArb, headingArb),
  { minLength: 1, maxLength: 12 },
).map((parts) => parts.join('\n\n'));

const cfg: ChunkerConfig = {
  ...DEFAULT_CHUNKER_CONFIG,
  chunkSize: 250,
  minChunkChars: 1,
};

describe('chunkMarkdown - properties', () => {
  it('chunkIndex is contiguous [0, 1, ..., n-1]', () => {
    fc.assert(
      fc.property(documentArb, (doc) => {
        const chunks = chunkMarkdown(doc, cfg);
        for (let i = 0; i < chunks.length; i++) {
          if (chunks[i].chunkIndex !== i) return false;
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it('no chunk content leaks a raw protect sentinel', () => {
    // Sentinels are Unicode Private Use Area chars.
    // If any chunk contains one, the restore step failed.
    const OPEN = '';
    const CLOSE = '';
    fc.assert(
      fc.property(documentArb, (doc) => {
        const chunks = chunkMarkdown(doc, cfg);
        for (const c of chunks) {
          if (c.content.includes(OPEN) || c.content.includes(CLOSE)) return false;
        }
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it('every protected region appears intact in exactly one chunk', () => {
    fc.assert(
      fc.property(fenceArb, paragraphArb, (fence, body) => {
        // Force a document where the fence is the only protected region.
        const doc = body + '\n\n' + fence + '\n\n' + body;
        const chunks = chunkMarkdown(doc, cfg);
        // The fence body plus its wrapping backticks must land whole inside
        // exactly one chunk — never split across chunks, never missing.
        const matching = chunks.filter((c) => c.content.includes(fence));
        return matching.length === 1;
      }),
      { numRuns: 100 },
    );
  });
});
