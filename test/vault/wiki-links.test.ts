import { describe, it, expect, vi } from 'vitest';
import {
  extractWikiLinks,
  buildStemLookup,
  resolveLink,
  rewriteWikiLinks,
} from '../../src/vault/wiki-links.js';

describe('extractWikiLinks', () => {
  it('extracts bare wiki links', () => {
    const links = extractWikiLinks('See [[Alice Smith]] for details.');
    expect(links).toEqual([{ raw: 'Alice Smith', display: null }]);
  });

  it('extracts path-qualified links', () => {
    const links = extractWikiLinks('Uses [[Concepts/Widget Theory]] extensively.');
    expect(links).toEqual([{ raw: 'Concepts/Widget Theory', display: null }]);
  });

  it('extracts pipe-aliased links', () => {
    const links = extractWikiLinks(
      'The [[Concepts/Widget Theory|widget framework]] works.',
    );
    expect(links).toEqual([
      { raw: 'Concepts/Widget Theory', display: 'widget framework' },
    ]);
  });

  it('ignores links inside code blocks', () => {
    const md = '```\n[[not a link]]\n```\nBut [[real link]] is.';
    const links = extractWikiLinks(md);
    expect(links).toEqual([{ raw: 'real link', display: null }]);
  });

  it('ignores embedded image links', () => {
    const links = extractWikiLinks('Look at ![[photo.png]] and [[real link]].');
    expect(links).toEqual([{ raw: 'real link', display: null }]);
  });

  it('extracts multiple links from one paragraph', () => {
    const links = extractWikiLinks(
      'Both [[Alice]] and [[Bob]] agreed on [[Plan]].',
    );
    expect(links).toHaveLength(3);
  });
});

describe('buildStemLookup', () => {
  it('maps filename stems to full paths', () => {
    const paths = ['People/Alice Smith.md', 'Concepts/Widget Theory.md'];
    const lookup = buildStemLookup(paths);
    expect(lookup.get('Alice Smith')).toEqual(['People/Alice Smith.md']);
    expect(lookup.get('Widget Theory')).toEqual(['Concepts/Widget Theory.md']);
  });

  it('detects ambiguous stems', () => {
    const paths = ['People/Alice Smith.md', 'Archive/Alice Smith.md'];
    const lookup = buildStemLookup(paths);
    expect(lookup.get('Alice Smith')).toHaveLength(2);
  });
});

describe('resolveLink', () => {
  const allPaths = [
    'People/Alice Smith.md',
    'People/Bob Jones.md',
    'Concepts/Widget Theory.md',
  ];
  const lookup = buildStemLookup(allPaths);

  it('resolves bare name to unique path', () => {
    expect(resolveLink('Alice Smith', lookup)).toBe('People/Alice Smith.md');
  });

  it('resolves path-qualified link directly', () => {
    expect(resolveLink('People/Bob Jones', lookup)).toBe('People/Bob Jones.md');
  });

  it('returns null for unresolvable links (stub nodes)', () => {
    expect(resolveLink('Nonexistent Page', lookup)).toBeNull();
  });

  // v1.7.20 V1: dedup ambiguous-link warnings via a per-parseVault Set.
  // Fires once per stem regardless of occurrence count.
  it('V1: ambiguous warning emits once per stem when warnedAmbiguous Set is threaded', () => {
    const ambiguousPaths = ['Fleeting/America.md', 'Misc/America.md', 'Permanent/America.md'];
    const ambLookup = buildStemLookup(ambiguousPaths);
    const warned = new Set<string>();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Five resolveLink calls with the same ambiguous stem — should warn once.
      for (let i = 0; i < 5; i++) {
        resolveLink('America', ambLookup, undefined, 'Daily/2024-01-01.md', warned);
      }
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toMatch(/Ambiguous wiki link \[\[America\]\]/);
      expect(warned.has('America')).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('V1: backwards-compat — resolveLink without warnedAmbiguous Set still warns per call', () => {
    const ambiguousPaths = ['Fleeting/America.md', 'Misc/America.md'];
    const ambLookup = buildStemLookup(ambiguousPaths);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      resolveLink('America', ambLookup);
      resolveLink('America', ambLookup);
      // No Set passed → no dedup → 2 warnings.
      expect(warnSpy).toHaveBeenCalledTimes(2);
    } finally {
      warnSpy.mockRestore();
    }
  });

  // v1.7.20 V2: same-folder preference for ambiguous resolution.
  // Mirrors Obsidian's UI resolver behaviour.
  it('V2: prefers same-folder candidate for ambiguous stems when referrerPath provided', () => {
    const paths = ['A/target.md', 'B/target.md', 'C/target.md'];
    const ambLookup = buildStemLookup(paths);
    expect(resolveLink('target', ambLookup, undefined, 'A/note.md')).toBe('A/target.md');
    expect(resolveLink('target', ambLookup, undefined, 'B/note.md')).toBe('B/target.md');
  });

  it('V2: falls back to first match when no candidate shares the referrer folder', () => {
    const paths = ['A/target.md', 'B/target.md'];
    const ambLookup = buildStemLookup(paths);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Referrer in folder 'X' — no same-folder match → first candidate wins.
      const result = resolveLink('target', ambLookup, undefined, 'X/note.md');
      expect(['A/target.md', 'B/target.md']).toContain(result);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('V2: backwards-compat — no referrerPath means no same-folder preference (falls back to first)', () => {
    const paths = ['A/target.md', 'B/target.md'];
    const ambLookup = buildStemLookup(paths);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = resolveLink('target', ambLookup);
      expect(['A/target.md', 'B/target.md']).toContain(result);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });
});

describe('rewriteWikiLinks', () => {
  it('rewrites a bare [[old]] link', () => {
    const { text, occurrences } = rewriteWikiLinks(
      'See [[old]] for details.',
      'old',
      'new',
    );
    expect(text).toBe('See [[new]] for details.');
    expect(occurrences).toBe(1);
  });

  it('preserves the display alias in [[old|display]]', () => {
    const { text, occurrences } = rewriteWikiLinks(
      'The [[old|widget framework]] works.',
      'old',
      'new',
    );
    expect(text).toBe('The [[new|widget framework]] works.');
    expect(occurrences).toBe(1);
  });

  it('preserves the ! prefix for embeds ![[old]]', () => {
    const { text, occurrences } = rewriteWikiLinks(
      'Embed: ![[old]] end.',
      'old',
      'new',
    );
    expect(text).toBe('Embed: ![[new]] end.');
    expect(occurrences).toBe(1);
  });

  it('preserves a #heading suffix', () => {
    const { text, occurrences } = rewriteWikiLinks(
      'Jump to [[old#Intro]].',
      'old',
      'new',
    );
    expect(text).toBe('Jump to [[new#Intro]].');
    expect(occurrences).toBe(1);
  });

  it('preserves a ^block suffix', () => {
    const { text, occurrences } = rewriteWikiLinks(
      'Block ref [[old^abc123]] here.',
      'old',
      'new',
    );
    expect(text).toBe('Block ref [[new^abc123]] here.');
    expect(occurrences).toBe(1);
  });

  it('leaves non-matching links untouched', () => {
    const { text, occurrences } = rewriteWikiLinks(
      'Mentions [[other]] and [[another]].',
      'old',
      'new',
    );
    expect(text).toBe('Mentions [[other]] and [[another]].');
    expect(occurrences).toBe(0);
  });

  it('counts every occurrence in mixed content', () => {
    const input =
      'First [[old]], then ![[old]], and [[old|alias]] plus [[other]].';
    const { text, occurrences } = rewriteWikiLinks(input, 'old', 'new');
    expect(text).toBe(
      'First [[new]], then ![[new]], and [[new|alias]] plus [[other]].',
    );
    expect(occurrences).toBe(3);
  });

  it('handles empty input', () => {
    expect(rewriteWikiLinks('', 'old', 'new')).toEqual({
      text: '',
      occurrences: 0,
    });
  });

  it('does not rewrite a link whose stem only contains oldStem as a substring', () => {
    const { text, occurrences } = rewriteWikiLinks(
      'Mention [[old-notes]] here.',
      'old',
      'new',
    );
    expect(text).toBe('Mention [[old-notes]] here.');
    expect(occurrences).toBe(0);
  });

  it('trims whitespace around the stem when matching', () => {
    const { text, occurrences } = rewriteWikiLinks(
      'Padded [[ old ]] link.',
      'old',
      'new',
    );
    expect(text).toBe('Padded [[new]] link.');
    expect(occurrences).toBe(1);
  });

  // v1.6.2 — document that special characters in old/new stems are safe. The
  // implementation uses stem equality + string concatenation, not regex
  // construction, so `&`, `()`, `+`, `?`, `$` never trigger metachar fallout.
  it('handles ampersands in the new stem', () => {
    const { text, occurrences } = rewriteWikiLinks(
      'I drive a [[BMW]] today.',
      'BMW',
      'BMW & Audi',
    );
    expect(text).toBe('I drive a [[BMW & Audi]] today.');
    expect(occurrences).toBe(1);
  });

  it('handles parentheses in the new stem', () => {
    const { text, occurrences } = rewriteWikiLinks(
      'See [[Notes]] here.',
      'Notes',
      'Notes (2025)',
    );
    expect(text).toBe('See [[Notes (2025)]] here.');
    expect(occurrences).toBe(1);
  });

  it('handles plus signs in the old and new stems', () => {
    const { text, occurrences } = rewriteWikiLinks(
      'Template in [[C++]] is hard.',
      'C++',
      'C Plus Plus',
    );
    expect(text).toBe('Template in [[C Plus Plus]] is hard.');
    expect(occurrences).toBe(1);
  });

  it('handles dollar signs in the new stem (no regex replacement-string interpolation)', () => {
    const { text, occurrences } = rewriteWikiLinks(
      'Price in [[dollars]].',
      'dollars',
      '$amount',
    );
    expect(text).toBe('Price in [[$amount]].');
    expect(occurrences).toBe(1);
  });

  // v1.6.4 — path-qualified wiki-links rewrite correctly when the note moves
  // across folders. The signature now takes full vault-relative paths
  // (`.md` included) so we can distinguish bare-stem from path-qualified
  // references and emit the correct replacement form for each.
  describe('path-qualified (v1.6.4)', () => {
    it('rewrites a path-qualified reference to the new full path when the folder changes', () => {
      const { text, occurrences } = rewriteWikiLinks(
        'See [[notes/BMW]] for details.',
        'notes/BMW.md',
        'cars/BMW & Audi.md',
      );
      expect(text).toBe('See [[cars/BMW & Audi]] for details.');
      expect(occurrences).toBe(1);
    });

    it('rewrites a bare-stem reference to the new bare stem (not folder-qualified)', () => {
      const { text, occurrences } = rewriteWikiLinks(
        'See [[BMW]] for details.',
        'notes/BMW.md',
        'cars/BMW & Audi.md',
      );
      expect(text).toBe('See [[BMW & Audi]] for details.');
      expect(occurrences).toBe(1);
    });

    it('rewrites a path-qualified reference with `.md` suffix', () => {
      const { text, occurrences } = rewriteWikiLinks(
        'See [[notes/BMW.md]] for details.',
        'notes/BMW.md',
        'cars/BMW & Audi.md',
      );
      expect(text).toBe('See [[cars/BMW & Audi]] for details.');
      expect(occurrences).toBe(1);
    });

    it('preserves heading suffixes on path-qualified rewrites', () => {
      const { text, occurrences } = rewriteWikiLinks(
        'Jump to [[notes/BMW#Specs]] now.',
        'notes/BMW.md',
        'cars/BMW & Audi.md',
      );
      expect(text).toBe('Jump to [[cars/BMW & Audi#Specs]] now.');
      expect(occurrences).toBe(1);
    });

    it('does not rewrite a path-qualified reference whose folder does not match the old path', () => {
      const { text, occurrences } = rewriteWikiLinks(
        'Other bike: [[other/BMW]] — unrelated.',
        'notes/BMW.md',
        'cars/BMW & Audi.md',
      );
      expect(text).toBe('Other bike: [[other/BMW]] — unrelated.');
      expect(occurrences).toBe(0);
    });

    it('rewrites only the matching folder when two same-stem files exist in different folders', () => {
      const { text, occurrences } = rewriteWikiLinks(
        'Active [[notes/BMW]] and archived [[archive/BMW]].',
        'notes/BMW.md',
        'cars/BMW & Audi.md',
      );
      // notes/BMW matched → rewritten. archive/BMW not matched → untouched.
      expect(text).toBe('Active [[cars/BMW & Audi]] and archived [[archive/BMW]].');
      expect(occurrences).toBe(1);
    });
  });
});
