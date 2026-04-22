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
});
