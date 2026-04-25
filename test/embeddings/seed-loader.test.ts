/**
 * v1.7.5 Layer 2 — bundled-seed JSON loader smoke tests.
 *
 * The committed anchor seed at `data/seed-models.json` always includes our
 * 6 canonical presets — assert presence + minimum-viable shape. Tests for
 * the malformed-shape / missing-file fallback paths live alongside the
 * resolver's chain tests (step 3 falls through to step 4 cleanly).
 */

import { describe, it, expect } from 'vitest';
import { loadSeed, getSeedMeta, _resetSeedCache } from '../../src/embeddings/seed-loader.js';

describe('seed-loader anchor', () => {
  it('loads without throwing and exposes a non-empty Map', () => {
    _resetSeedCache();
    const seed = loadSeed();
    expect(seed.size).toBeGreaterThan(0);
  });

  it('contains every canonical preset model id', () => {
    _resetSeedCache();
    const seed = loadSeed();
    const expected = [
      'Xenova/bge-small-en-v1.5',
      'Xenova/bge-base-en-v1.5',
      'MongoDB/mdbr-leaf-ir',
      'Xenova/multilingual-e5-small',
      'Xenova/multilingual-e5-base',
      'bge-m3',
    ];
    for (const id of expected) {
      expect(seed.has(id), `seed missing canonical model ${id}`).toBe(true);
    }
  });

  it('every seed entry has required fields', () => {
    _resetSeedCache();
    const seed = loadSeed();
    for (const [id, entry] of seed.entries()) {
      expect(typeof entry.dim).toBe('number');
      expect(typeof entry.maxTokens).toBe('number');
      expect(typeof entry.modelType).toBe('string');
      // queryPrefix and documentPrefix are nullable strings.
      expect(entry.queryPrefix === null || typeof entry.queryPrefix === 'string').toBe(true);
      expect(entry.documentPrefix === null || typeof entry.documentPrefix === 'string').toBe(true);
      void id;
    }
  });

  it('asymmetric BGE entry has the canonical mxbai/bge query prompt', () => {
    _resetSeedCache();
    const seed = loadSeed();
    const bge = seed.get('Xenova/bge-small-en-v1.5');
    expect(bge?.queryPrefix).toBe('Represent this sentence for searching relevant passages: ');
    expect(bge?.documentPrefix).toBe('');
  });

  it('exposes seed metadata via getSeedMeta', () => {
    _resetSeedCache();
    const meta = getSeedMeta();
    expect(meta).not.toBeNull();
    expect(typeof meta?.entries).toBe('number');
    expect(meta!.entries).toBeGreaterThan(0);
  });
});
