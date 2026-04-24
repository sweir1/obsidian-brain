import { describe, it, expect } from 'vitest';
import { escapeFts5Query } from '../../src/store/fts5-escape.js';

describe('store/fts5-escape', () => {
  it('phrase-quotes hyphenated queries', () => {
    expect(escapeFts5Query('verify-hyphen-20260422')).toBe('"verify-hyphen-20260422"');
  });

  it('phrase-quotes queries with colon', () => {
    expect(escapeFts5Query('title:foo')).toBe('"title:foo"');
  });

  it('passes through plain alphanumeric + space', () => {
    expect(escapeFts5Query('foo bar')).toBe('foo bar');
  });

  it('passes through AND-ed plain words', () => {
    expect(escapeFts5Query('foo AND bar')).toBe('foo AND bar');
  });

  it('passes through asterisk (prefix matching)', () => {
    expect(escapeFts5Query('prefix*')).toBe('prefix*');
  });

  it('phrase-quotes queries with parens', () => {
    expect(escapeFts5Query('NEAR(foo bar, 5)')).toBe('"NEAR(foo bar, 5)"');
  });

  it('doubles internal double quotes when phrase-quoting', () => {
    expect(escapeFts5Query('say "hello"')).toBe('"say ""hello"""');
  });

  it('passes through empty string', () => {
    expect(escapeFts5Query('')).toBe('');
  });

  // The fast-path regex `^[\w\s*]+$` uses JS `\w`, which is ASCII-only. Any
  // non-ASCII letter (é, 日, emoji) fails the regex and lands on the
  // phrase-quote path. That's safe — phrase-quoted FTS5 phrases bypass
  // operator parsing entirely — but the behaviour needs asserting so no one
  // "fixes" the regex to `/u\p{L}` without thinking through FTS5 tokenizer
  // implications. Obsidian vaults routinely contain non-ASCII titles.
  describe('non-ASCII inputs', () => {
    it('phrase-quotes accented Latin chars', () => {
      expect(escapeFts5Query('café')).toBe('"café"');
    });

    it('phrase-quotes CJK chars', () => {
      expect(escapeFts5Query('日本語')).toBe('"日本語"');
    });

    it('phrase-quotes emoji', () => {
      expect(escapeFts5Query('party 🎉')).toBe('"party 🎉"');
    });

    it('phrase-quotes mixed ASCII + non-ASCII', () => {
      expect(escapeFts5Query('café notes')).toBe('"café notes"');
    });
  });
});

// Round-trip validation: an escaped query must parse as a valid FTS5 MATCH
// expression without throwing "malformed MATCH expression" or similar. This
// exercises the actual grammar rather than just the escape function's string
// output, so a regex regression surfaces as an integration failure.
describe('store/fts5-escape - FTS5 MATCH round-trip', () => {
  it('escaped non-ASCII queries parse as valid MATCH expressions', async () => {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(':memory:');
    try {
      db.exec("CREATE VIRTUAL TABLE t USING fts5(body)");
      db.prepare("INSERT INTO t(body) VALUES ('café notes'), ('日本語 tests'), ('plain text')").run();

      const cases = ['café', '日本語', 'café notes', 'verify-hyphen-2026', 'title:foo'];
      for (const raw of cases) {
        const escaped = escapeFts5Query(raw);
        // Must not throw — FTS5 rejects malformed MATCH with "fts5: syntax error".
        expect(() => db.prepare('SELECT rowid FROM t WHERE t MATCH ?').all(escaped)).not.toThrow();
      }
    } finally {
      db.close();
    }
  });
});
