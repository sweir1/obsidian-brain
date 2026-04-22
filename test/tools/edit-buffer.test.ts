import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { EditBuffer } from '../../src/tools/edit-buffer.js';

function makeEntry(overrides: Partial<Parameters<EditBuffer['push']>[0]> = {}) {
  return {
    path: 'notes/foo.md',
    content: 'replacement content',
    search: 'original text',
    mode: 'replace_window',
    failedAt: Date.now(),
    error: '[replace_window] NoMatch: search text not found',
    ...overrides,
  };
}

describe('EditBuffer', () => {
  let buf: EditBuffer;

  beforeEach(() => {
    buf = new EditBuffer();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('push then get returns the same entry', () => {
    const entry = makeEntry();
    buf.push(entry);
    const got = buf.get('notes/foo.md');
    expect(got).toBeDefined();
    expect(got!.content).toBe(entry.content);
    expect(got!.search).toBe(entry.search);
    expect(got!.path).toBe(entry.path);
  });

  it('get on unknown path returns undefined', () => {
    expect(buf.get('notes/nonexistent.md')).toBeUndefined();
  });

  it('pushing two entries for the same path replaces (not appends)', () => {
    const first = makeEntry({ content: 'first content', failedAt: Date.now() });
    const second = makeEntry({ content: 'second content', failedAt: Date.now() });
    buf.push(first);
    buf.push(second);
    const got = buf.get('notes/foo.md');
    expect(got).toBeDefined();
    expect(got!.content).toBe('second content');
    // Only one entry for this path
    // Push a different path to see count behavior
    buf.push(makeEntry({ path: 'notes/bar.md', content: 'bar content' }));
    // foo still resolves to second
    expect(buf.get('notes/foo.md')!.content).toBe('second content');
  });

  it('after 30-min TTL, get returns undefined', () => {
    const entry = makeEntry({ failedAt: Date.now() });
    buf.push(entry);
    expect(buf.get('notes/foo.md')).toBeDefined();

    // Advance past TTL
    vi.advanceTimersByTime(30 * 60 * 1000 + 1);
    expect(buf.get('notes/foo.md')).toBeUndefined();
  });

  it('pushing a 21st entry for a different path evicts the oldest', () => {
    // Fill 20 entries with distinct paths
    for (let i = 0; i < 20; i++) {
      buf.push(makeEntry({ path: `notes/file-${i}.md`, failedAt: Date.now() }));
    }
    // All 20 should be present
    expect(buf.get('notes/file-0.md')).toBeDefined();

    // Push a 21st with a new path — should evict oldest (file-0)
    buf.push(makeEntry({ path: 'notes/file-20.md', failedAt: Date.now() }));
    expect(buf.get('notes/file-0.md')).toBeUndefined();
    expect(buf.get('notes/file-20.md')).toBeDefined();
    // file-1 through file-19 still present
    expect(buf.get('notes/file-1.md')).toBeDefined();
    expect(buf.get('notes/file-19.md')).toBeDefined();
  });

  it('pushing content >512KB returns { buffered: false, reason }', () => {
    const bigContent = 'x'.repeat(512 * 1024 + 1);
    const result = buf.push(makeEntry({ content: bigContent }));
    expect(result.buffered).toBe(false);
    expect(result.reason).toMatch(/content too large to buffer/);
    // Should not be stored
    expect(buf.get('notes/foo.md')).toBeUndefined();
  });

  it('pushing content exactly at limit (512KB) is accepted', () => {
    const okContent = 'x'.repeat(512 * 1024);
    const result = buf.push(makeEntry({ content: okContent }));
    expect(result.buffered).toBe(true);
    expect(buf.get('notes/foo.md')).toBeDefined();
  });

  it('remove clears a path', () => {
    buf.push(makeEntry());
    expect(buf.get('notes/foo.md')).toBeDefined();
    buf.remove('notes/foo.md');
    expect(buf.get('notes/foo.md')).toBeUndefined();
  });

  it('remove on unknown path is a no-op', () => {
    buf.push(makeEntry());
    buf.remove('notes/nonexistent.md');
    expect(buf.get('notes/foo.md')).toBeDefined();
  });
});
