import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PreviewStore, type PendingEdit } from '../../src/tools/preview-store.js';

function makePreview(overrides: Partial<PendingEdit> = {}): PendingEdit {
  return {
    previewId: 'prev_test-id',
    path: 'note.md',
    originalContent: 'original',
    proposedContent: 'proposed',
    diff: '--- original\n+++ proposed\n',
    mode: 'append',
    createdAt: Date.now(),
    ...overrides,
  };
}

describe('PreviewStore', () => {
  let store: PreviewStore;

  beforeEach(() => {
    store = new PreviewStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('set then get returns the same preview', () => {
    const p = makePreview({ previewId: 'prev_abc' });
    store.set(p);
    expect(store.get('prev_abc')).toEqual(p);
  });

  it('get on unknown id returns undefined', () => {
    expect(store.get('prev_does-not-exist')).toBeUndefined();
  });

  it('get returns undefined after TTL has elapsed (5 minutes)', () => {
    vi.useFakeTimers();
    const p = makePreview({ previewId: 'prev_ttl', createdAt: Date.now() });
    store.set(p);
    expect(store.get('prev_ttl')).toBeDefined();

    // Advance past the 5-minute TTL.
    vi.advanceTimersByTime(5 * 60 * 1000 + 1);

    expect(store.get('prev_ttl')).toBeUndefined();
  });

  it('adding a 51st preview evicts the oldest entry', () => {
    vi.useFakeTimers();
    const baseTime = Date.now();

    // Fill to cap (50 entries).
    for (let i = 0; i < 50; i++) {
      store.set(
        makePreview({
          previewId: `prev_${i}`,
          createdAt: baseTime + i,
        }),
      );
    }
    expect(store.size).toBe(50);

    // The oldest is prev_0 (createdAt = baseTime + 0).
    expect(store.get('prev_0')).toBeDefined();

    // Add the 51st entry — must evict prev_0.
    store.set(makePreview({ previewId: 'prev_overflow', createdAt: baseTime + 50 }));

    expect(store.size).toBe(50);
    expect(store.get('prev_0')).toBeUndefined();
    expect(store.get('prev_overflow')).toBeDefined();
  });

  it('delete removes the preview and returns true', () => {
    const p = makePreview({ previewId: 'prev_del' });
    store.set(p);
    expect(store.delete('prev_del')).toBe(true);
    expect(store.get('prev_del')).toBeUndefined();
  });

  it('delete returns false for a non-existent id', () => {
    expect(store.delete('prev_ghost')).toBe(false);
  });
});
