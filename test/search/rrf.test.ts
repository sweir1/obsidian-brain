import { describe, it, expect } from 'vitest';
import { reciprocalRankFusion } from '../../src/search/unified.js';

interface Item { id: string }

describe('reciprocalRankFusion', () => {
  const key = (i: Item) => i.id;

  it('returns empty for empty input', () => {
    expect(reciprocalRankFusion<Item>([], key)).toEqual([]);
    expect(reciprocalRankFusion<Item>([[]], key)).toEqual([]);
  });

  it('single-list passthrough preserves order', () => {
    const list = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
    const fused = reciprocalRankFusion([list], key);
    expect(fused.map((r) => r.item.id)).toEqual(['a', 'b', 'c']);
  });

  it('rank-1 in both lists dominates over rank-1 in only one', () => {
    const semantic = [{ id: 'shared' }, { id: 'sem-only' }];
    const fulltext = [{ id: 'shared' }, { id: 'ft-only' }];
    const fused = reciprocalRankFusion([semantic, fulltext], key);
    expect(fused[0].item.id).toBe('shared');
  });

  it('adds contributions across lists', () => {
    const semantic = [{ id: 'a' }, { id: 'b' }];
    const fulltext = [{ id: 'a' }, { id: 'b' }];
    const fused = reciprocalRankFusion([semantic, fulltext], key, 60);
    const a = fused.find((r) => r.item.id === 'a');
    expect(a).toBeDefined();
    // Both lists have 'a' at rank 0 (1-indexed 1): contribution = 1/(60+1) each.
    expect(a!.score).toBeCloseTo(2 / 61, 10);
  });

  it('later ranks contribute less than earlier ones', () => {
    const list = [{ id: 'top' }, { id: 'mid' }, { id: 'tail' }];
    const fused = reciprocalRankFusion([list], key);
    const top = fused.find((r) => r.item.id === 'top')!;
    const tail = fused.find((r) => r.item.id === 'tail')!;
    expect(top.score).toBeGreaterThan(tail.score);
  });

  it('an item appearing in both lists outranks items appearing in only one', () => {
    const semantic = [
      { id: 'sem1' },
      { id: 'sem2' },
      { id: 'both' },
    ];
    const fulltext = [
      { id: 'ft1' },
      { id: 'ft2' },
      { id: 'both' },
    ];
    const fused = reciprocalRankFusion([semantic, fulltext], key);
    // 'both' appears at rank 3 (idx 2) in each list; sum of two rank-3
    // contributions > any single rank-1 contribution if k is small enough
    // — with k=60 the single rank-1 wins, so 'both' should NOT be top.
    // But 'both' still beats any rank-3 item appearing in only one list.
    const bothPos = fused.findIndex((r) => r.item.id === 'both');
    const sem2Pos = fused.findIndex((r) => r.item.id === 'sem2');
    const ft2Pos = fused.findIndex((r) => r.item.id === 'ft2');
    expect(bothPos).toBeLessThan(sem2Pos);
    expect(bothPos).toBeLessThan(ft2Pos);
  });

  it('k parameter is respected', () => {
    const list = [{ id: 'a' }];
    const withK0 = reciprocalRankFusion([list], key, 0);
    const withK100 = reciprocalRankFusion([list], key, 100);
    expect(withK0[0].score).toBeCloseTo(1 / 1, 10);
    expect(withK100[0].score).toBeCloseTo(1 / 101, 10);
  });
});
