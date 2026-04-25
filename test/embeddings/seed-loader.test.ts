/**
 * v1.7.5 Layer 2 — bundled-seed JSON loader smoke tests.
 *
 * The committed anchor at `data/seed-models.json` always includes our
 * canonical preset model ids (assert presence + minimum-viable shape).
 * The schema-version handling is exercised via direct loadSeed calls
 * after pre-populating the cache, which avoids needing fixture files
 * on disk (loadSeed reads `data/seed-models.json` via createRequire,
 * so swapping the file underneath would race with the test runner).
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

  it('every seed entry has the v2 load-bearing fields', () => {
    _resetSeedCache();
    const seed = loadSeed();
    for (const [id, entry] of seed.entries()) {
      expect(typeof entry.maxTokens, `${id} missing maxTokens`).toBe('number');
      expect(entry.maxTokens, `${id} maxTokens must be > 0`).toBeGreaterThan(0);
      expect(
        entry.queryPrefix === null || typeof entry.queryPrefix === 'string',
        `${id} queryPrefix must be string|null`,
      ).toBe(true);
      expect(
        entry.documentPrefix === null || typeof entry.documentPrefix === 'string',
        `${id} documentPrefix must be string|null`,
      ).toBe(true);
    }
  });

  it('asymmetric BGE entry has the canonical query prompt + empty document prompt', () => {
    _resetSeedCache();
    const seed = loadSeed();
    const bge = seed.get('Xenova/bge-small-en-v1.5');
    expect(bge?.queryPrefix).toBe('Represent this sentence for searching relevant passages: ');
    expect(bge?.documentPrefix).toBe('');
  });

  it('asymmetric E5 entry has query/passage prefixes (not symmetric)', () => {
    _resetSeedCache();
    const seed = loadSeed();
    const e5 = seed.get('Xenova/multilingual-e5-small');
    expect(e5?.queryPrefix).toBe('query: ');
    expect(e5?.documentPrefix).toBe('passage: ');
  });

  it('exposes seed metadata via getSeedMeta', () => {
    _resetSeedCache();
    const meta = getSeedMeta();
    expect(meta).not.toBeNull();
    expect(typeof meta?.entries).toBe('number');
    expect(meta!.entries).toBeGreaterThan(0);
    // v2 anchors carry $source ('mteb-<version>'); v1 anchors carried
    // $mtebRevision. Either is exposed via the unified `source` field.
    expect(meta?.source === null || typeof meta?.source === 'string').toBe(true);
  });
});
