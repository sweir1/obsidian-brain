/**
 * Parser link/tag semantics aligned with Obsidian:
 *   - same-note `[[#Section]]` / `[[^block]]` links create no edge and no stub
 *   - inline tags ignore code, wiki links, URLs, link targets and comments
 *   - note embeds `![[Note]]` are links; attachment links/embeds are not
 *   - link resolution falls back to case-insensitive matching
 */
import { describe, it, expect } from 'vitest';
import { parseFileFromContent } from '../../src/vault/parser.js';
import { buildStemLookup } from '../../src/vault/wiki-links.js';

function parse(content: string, paths: string[] = [], relPath = 'src.md') {
  const all = [...paths, relPath];
  return parseFileFromContent(relPath, content, buildStemLookup(all), new Set(all));
}

describe('same-note heading / block links', () => {
  it('create neither an edge nor a `_stub/.md` stub', () => {
    const { edges, stubIds } = parse(
      'Jump to [[#Section]], [[^block1]], [[#Section|the section]] or ![[#Embedded part]].',
    );
    expect(edges).toEqual([]);
    expect(stubIds.size).toBe(0);
  });

  it('leave cross-note heading links untouched', () => {
    const { edges, stubIds } = parse('See [[Other#Section]] and [[#Local]].', ['Other.md']);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ targetId: 'Other.md', targetSubpath: 'Section' });
    expect(stubIds.size).toBe(0);
  });
});

describe('inline tags', () => {
  const tagsOf = (content: string): unknown => parse(content).node.frontmatter.inline_tags;

  it('still finds ordinary tags', () => {
    expect(tagsOf('Working on #project/alpha and #todo today.\n#start-of-line')).toEqual([
      'project/alpha',
      'todo',
      'start-of-line',
    ]);
  });

  it('ignores `#` inside wiki links and embeds', () => {
    expect(tagsOf('See [[#Section]], [[Note#Heading]] and ![[Doc#Part]]. Real #tag')).toEqual(['tag']);
  });

  it('ignores tags in fenced code, ~~~ fences and inline code', () => {
    const md = '```\n#incode\n```\n~~~\n#tilde\n~~~\nInline `#span` and #real';
    expect(tagsOf(md)).toEqual(['real']);
  });

  it('ignores URL fragments, autolinks and markdown link targets', () => {
    const md = [
      'Visit https://example.com/page#anchor and <https://x.org/#frag>.',
      'Jump [to heading](#heading-link) or [other](page.md#frag) — keep #kept',
    ].join('\n');
    expect(tagsOf(md)).toEqual(['kept']);
  });

  it('ignores HTML comments, %% comments %% and HTML entities', () => {
    const md = '<!-- #hidden -->\n%% #secret\nmultiline %%\nIt&#x27;s fine. #visible';
    expect(tagsOf(md)).toEqual(['visible']);
  });

  it('accepts Unicode letters and combining marks', () => {
    expect(tagsOf('Notes #café #日本語 #über #привет #Ελληνικά #हिन्दी')).toEqual([
      'café',
      '日本語',
      'über',
      'привет',
      'Ελληνικά',
      'हिन्दी',
    ]);
  });

  it('allows digits anywhere but rejects all-numeric tags', () => {
    expect(tagsOf('#2024 #y2024 #2024-review #123abc #42 #v1/2')).toEqual([
      'y2024',
      '2024-review',
      '123abc',
      'v1/2',
    ]);
  });

  it('keeps `_ - /` inside tags and stops at other punctuation', () => {
    expect(tagsOf('#snake_case, #kebab-case. #parent/child! #end')).toEqual([
      'snake_case',
      'kebab-case',
      'parent/child',
      'end',
    ]);
  });

  it('a `#` glued to a preceding letter or digit (ASCII or not) is not a tag', () => {
    expect(tagsOf('foo#bar café#x 12#y snake_#z ok')).toBeUndefined();
  });

  it('omits inline_tags entirely when only excluded `#` occurrences exist', () => {
    expect(tagsOf('Only [[#Section]] here.')).toBeUndefined();
  });
});

describe('embeds and attachments', () => {
  it('a note embed produces an edge like a normal link, keeping its subpath', () => {
    const { edges, stubIds } = parse('Transcluded:\n\n![[Note]]\n\n![[Note#Heading]]', ['Note.md']);
    expect(edges.map((e) => [e.targetId, e.targetSubpath])).toEqual([
      ['Note.md', null],
      ['Note.md', 'Heading'],
    ]);
    expect(stubIds.size).toBe(0);
  });

  it('an embed of a missing note becomes a stub, same as a missing link', () => {
    const { edges, stubIds } = parse('![[Not Yet Written]]');
    expect(edges[0]!.targetId).toBe('_stub/Not Yet Written.md');
    expect([...stubIds]).toEqual(['_stub/Not Yet Written.md']);
  });

  it('attachment embeds and links create no edge and no `.png.md` stub', () => {
    const { edges, stubIds } = parse(
      '![[diagram.png]] ![[audio.mp3]] [[file.pdf]] ![[assets/photo.JPG|300]] [[spec.pdf#page=3]] [[Real]]',
    );
    expect(edges.map((e) => e.targetId)).toEqual(['_stub/Real.md']);
    expect([...stubIds]).toEqual(['_stub/Real.md']);
  });

  it('a dotted note name is still a note link', () => {
    const { edges } = parse('[[v1.2 release notes]] and [[J.R.R. Tolkien]]');
    expect(edges.map((e) => e.targetId)).toEqual([
      '_stub/v1.2 release notes.md',
      '_stub/J.R.R. Tolkien.md',
    ]);
  });

  it('a real note named like an attachment still resolves', () => {
    const { edges } = parse('[[chart.png]]', ['chart.png.md']);
    expect(edges.map((e) => e.targetId)).toEqual(['chart.png.md']);
  });

  it('the embed edge context drops the embed syntax', () => {
    const { edges } = parse('Intro line\n![[Note]]', ['Note.md']);
    expect(edges[0]!.context).toBe('Intro line');
  });
});

describe('case-insensitive resolution', () => {
  it('[[note]] resolves to Note.md instead of creating a stub', () => {
    const { edges, stubIds } = parse('See [[note]] and [[folder/deep note]].', [
      'Note.md',
      'Folder/Deep Note.md',
    ]);
    expect(edges.map((e) => e.targetId)).toEqual(['Note.md', 'Folder/Deep Note.md']);
    expect(stubIds.size).toBe(0);
  });
});
