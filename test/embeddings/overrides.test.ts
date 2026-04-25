/**
 * v1.7.5 user-config layer — `model-overrides.json` round-trip + validation.
 *
 * Uses a temp directory via `OBSIDIAN_BRAIN_CONFIG_DIR` so tests don't
 * touch the developer's real `~/.config/obsidian-brain/`. Each test
 * resets the in-process cache + the env override.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _resetOverridesCache,
  loadOverrides,
  removeOverride,
  saveOverride,
} from '../../src/embeddings/overrides.js';
import { getOverridesPath } from '../../src/embeddings/user-config.js';

let tmp: string;
let priorEnv: string | undefined;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'obrain-overrides-'));
  priorEnv = process.env.OBSIDIAN_BRAIN_CONFIG_DIR;
  process.env.OBSIDIAN_BRAIN_CONFIG_DIR = tmp;
  _resetOverridesCache();
});

afterEach(() => {
  if (priorEnv === undefined) delete process.env.OBSIDIAN_BRAIN_CONFIG_DIR;
  else process.env.OBSIDIAN_BRAIN_CONFIG_DIR = priorEnv;
  _resetOverridesCache();
  rmSync(tmp, { recursive: true, force: true });
});

describe('overrides — empty / missing file', () => {
  it('loadOverrides() returns an empty Map when no file exists', () => {
    expect(loadOverrides().size).toBe(0);
  });

  it('removeOverride() returns false when no file exists', () => {
    expect(removeOverride('any/id')).toBe(false);
  });
});

describe('overrides — round-trip', () => {
  it('saveOverride writes the file and loadOverrides reads it back', () => {
    saveOverride('MongoDB/mdbr-leaf-ir', { maxTokens: 1024 });
    _resetOverridesCache();
    const map = loadOverrides();
    expect(map.size).toBe(1);
    expect(map.get('MongoDB/mdbr-leaf-ir')).toEqual({ maxTokens: 1024 });
  });

  it('saveOverride merges with existing fields (does not overwrite)', () => {
    saveOverride('foo/bar', { maxTokens: 512 });
    saveOverride('foo/bar', { queryPrefix: 'q: ' });
    _resetOverridesCache();
    const ov = loadOverrides().get('foo/bar');
    expect(ov?.maxTokens).toBe(512);
    expect(ov?.queryPrefix).toBe('q: ');
  });

  it('removeOverride with no field clears the entire entry', () => {
    saveOverride('foo/bar', { maxTokens: 1, queryPrefix: 'q' });
    expect(removeOverride('foo/bar')).toBe(true);
    _resetOverridesCache();
    expect(loadOverrides().has('foo/bar')).toBe(false);
  });

  it('removeOverride with a field clears only that field', () => {
    saveOverride('foo/bar', { maxTokens: 1, queryPrefix: 'q' });
    expect(removeOverride('foo/bar', 'maxTokens')).toBe(true);
    _resetOverridesCache();
    const ov = loadOverrides().get('foo/bar');
    expect(ov?.maxTokens).toBeUndefined();
    expect(ov?.queryPrefix).toBe('q');
  });

  it('removeOverride deletes the entry when the last field is removed', () => {
    saveOverride('foo/bar', { maxTokens: 1 });
    expect(removeOverride('foo/bar', 'maxTokens')).toBe(true);
    _resetOverridesCache();
    expect(loadOverrides().has('foo/bar')).toBe(false);
  });
});

describe('overrides — validation', () => {
  it('rejects non-positive maxTokens but keeps the rest of the entry', () => {
    writeFileSync(
      getOverridesPath(),
      JSON.stringify({
        $version: 1,
        models: {
          'foo/bar': { maxTokens: -5, queryPrefix: 'q: ' },
        },
      }),
    );
    _resetOverridesCache();
    const ov = loadOverrides().get('foo/bar');
    expect(ov?.maxTokens).toBeUndefined();
    expect(ov?.queryPrefix).toBe('q: ');
  });

  it('rejects non-string non-null prefix values', () => {
    writeFileSync(
      getOverridesPath(),
      JSON.stringify({
        $version: 1,
        models: {
          'foo/bar': { queryPrefix: { wrong: 'shape' }, maxTokens: 512 },
        },
      }),
    );
    _resetOverridesCache();
    const ov = loadOverrides().get('foo/bar');
    expect(ov?.queryPrefix).toBeUndefined();
    expect(ov?.maxTokens).toBe(512);
  });

  it('accepts null prefix as "explicitly clear"', () => {
    saveOverride('foo/bar', { queryPrefix: null });
    _resetOverridesCache();
    const ov = loadOverrides().get('foo/bar');
    expect(ov?.queryPrefix).toBeNull();
  });

  it('ignores entries with an unsupported $version', () => {
    writeFileSync(
      getOverridesPath(),
      JSON.stringify({ $version: 99, models: { 'foo/bar': { maxTokens: 1 } } }),
    );
    _resetOverridesCache();
    expect(loadOverrides().size).toBe(0);
  });

  it('ignores invalid JSON', () => {
    writeFileSync(getOverridesPath(), '{ not valid json');
    _resetOverridesCache();
    expect(loadOverrides().size).toBe(0);
  });
});
