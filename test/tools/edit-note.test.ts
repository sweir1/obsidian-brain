import { describe, it, expect } from 'vitest';
import { parseValueJson } from '../../src/tools/edit-note.js';

describe('parseValueJson (F12 harness-compat)', () => {
  it('parses JSON null into real null', () => {
    expect(parseValueJson('null')).toBeNull();
  });

  it('parses JSON true into boolean', () => {
    expect(parseValueJson('true')).toBe(true);
  });

  it('parses JSON number', () => {
    expect(parseValueJson('42')).toBe(42);
  });

  it('parses JSON array', () => {
    expect(parseValueJson('["a","b"]')).toEqual(['a', 'b']);
  });

  it('parses JSON object', () => {
    expect(parseValueJson('{"k":1}')).toEqual({ k: 1 });
  });

  it('parses JSON string', () => {
    expect(parseValueJson('"hello"')).toBe('hello');
  });

  it('throws a clear error on invalid JSON', () => {
    expect(() => parseValueJson('{not json')).toThrow(
      /valueJson is not valid JSON/,
    );
  });
});
