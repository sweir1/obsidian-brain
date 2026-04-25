import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  EMBEDDING_PRESETS,
  DEPRECATED_PRESET_ALIASES,
  resolveEmbeddingModel,
  resolveEmbeddingProvider,
  _resetAliasWarnings,
} from '../../src/embeddings/presets.js';

// Capture stderr writes without actually printing them.
let stderrOutput = '';
beforeEach(() => {
  stderrOutput = '';
  _resetAliasWarnings();
  vi.spyOn(process.stderr, 'write').mockImplementation((msg: string | Uint8Array) => {
    stderrOutput += typeof msg === 'string' ? msg : '';
    return true;
  });
});

describe('resolveEmbeddingModel — canonical presets', () => {
  it('defaults to english preset (bge-small-en-v1.5) with empty env', () => {
    expect(resolveEmbeddingModel({})).toBe('Xenova/bge-small-en-v1.5');
  });

  it('resolves english preset', () => {
    expect(resolveEmbeddingModel({ EMBEDDING_PRESET: 'english' })).toBe('Xenova/bge-small-en-v1.5');
  });

  it('resolves english-fast preset', () => {
    expect(resolveEmbeddingModel({ EMBEDDING_PRESET: 'english-fast' })).toBe('Xenova/paraphrase-MiniLM-L3-v2');
  });

  it('resolves english-quality preset', () => {
    expect(resolveEmbeddingModel({ EMBEDDING_PRESET: 'english-quality' })).toBe('Xenova/bge-base-en-v1.5');
  });

  it('resolves multilingual preset', () => {
    expect(resolveEmbeddingModel({ EMBEDDING_PRESET: 'multilingual' })).toBe('Xenova/multilingual-e5-small');
  });

  it('resolves multilingual-quality preset', () => {
    expect(resolveEmbeddingModel({ EMBEDDING_PRESET: 'multilingual-quality' })).toBe('Xenova/multilingual-e5-base');
  });

  it('resolves multilingual-ollama preset', () => {
    expect(resolveEmbeddingModel({ EMBEDDING_PRESET: 'multilingual-ollama' })).toBe('bge-m3');
  });

  it('is case-insensitive on preset name', () => {
    expect(resolveEmbeddingModel({ EMBEDDING_PRESET: 'MULTILINGUAL' })).toBe('Xenova/multilingual-e5-small');
    expect(resolveEmbeddingModel({ EMBEDDING_PRESET: 'English-Quality' })).toBe('Xenova/bge-base-en-v1.5');
  });

  it('trims whitespace on preset name', () => {
    expect(resolveEmbeddingModel({ EMBEDDING_PRESET: '  english  ' })).toBe('Xenova/bge-small-en-v1.5');
  });

  it('EMBEDDING_MODEL overrides EMBEDDING_PRESET', () => {
    expect(resolveEmbeddingModel({ EMBEDDING_MODEL: 'custom/model', EMBEDDING_PRESET: 'english-fast' })).toBe('custom/model');
  });

  it('EMBEDDING_MODEL accepts any custom model id (power-user path)', () => {
    expect(resolveEmbeddingModel({ EMBEDDING_MODEL: 'BAAI/bge-large-en-v1.5' })).toBe('BAAI/bge-large-en-v1.5');
  });

  it('empty EMBEDDING_MODEL falls through to preset (not picked up as empty string override)', () => {
    expect(resolveEmbeddingModel({ EMBEDDING_MODEL: '', EMBEDDING_PRESET: 'english-fast' })).toBe('Xenova/paraphrase-MiniLM-L3-v2');
  });
});

describe('resolveEmbeddingModel — deprecated aliases', () => {
  it('EMBEDDING_PRESET=fastest resolves to paraphrase-MiniLM-L3-v2 (same model as english-fast)', () => {
    const model = resolveEmbeddingModel({ EMBEDDING_PRESET: 'fastest' });
    expect(model).toBe('Xenova/paraphrase-MiniLM-L3-v2');
  });

  it('EMBEDDING_PRESET=fastest emits rename warning on stderr', () => {
    resolveEmbeddingModel({ EMBEDDING_PRESET: 'fastest' });
    expect(stderrOutput).toContain('EMBEDDING_PRESET="fastest" is deprecated');
    expect(stderrOutput).toContain('english-fast');
  });

  it('fastest warning is only emitted once per process lifetime', () => {
    resolveEmbeddingModel({ EMBEDDING_PRESET: 'fastest' });
    resolveEmbeddingModel({ EMBEDDING_PRESET: 'fastest' });
    const count = (stderrOutput.match(/fastest.*is deprecated/g) ?? []).length;
    expect(count).toBe(1);
  });

  it('EMBEDDING_PRESET=balanced resolves to bge-small-en-v1.5 (model change)', () => {
    const model = resolveEmbeddingModel({ EMBEDDING_PRESET: 'balanced' });
    expect(model).toBe('Xenova/bge-small-en-v1.5');
  });

  it('EMBEDDING_PRESET=balanced emits model-change warning on stderr', () => {
    resolveEmbeddingModel({ EMBEDDING_PRESET: 'balanced' });
    expect(stderrOutput).toContain('EMBEDDING_PRESET="balanced" is deprecated');
    expect(stderrOutput).toContain('Xenova/bge-small-en-v1.5');
    expect(stderrOutput).toContain('Xenova/all-MiniLM-L6-v2');
    expect(stderrOutput).toContain('re-embed');
  });

  it('balanced warning explicitly mentions model change (not just rename)', () => {
    resolveEmbeddingModel({ EMBEDDING_PRESET: 'balanced' });
    expect(stderrOutput).toContain('different model');
    expect(stderrOutput).toContain('EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2');
  });

  it('balanced warning is only emitted once per process lifetime', () => {
    resolveEmbeddingModel({ EMBEDDING_PRESET: 'balanced' });
    resolveEmbeddingModel({ EMBEDDING_PRESET: 'balanced' });
    const count = (stderrOutput.match(/EMBEDDING_PRESET="balanced"/g) ?? []).length;
    expect(count).toBe(1);
  });

  it('DEPRECATED_PRESET_ALIASES maps fastest to english-fast', () => {
    expect(DEPRECATED_PRESET_ALIASES['fastest']).toBe('english-fast');
  });

  it('DEPRECATED_PRESET_ALIASES maps balanced to english', () => {
    expect(DEPRECATED_PRESET_ALIASES['balanced']).toBe('english');
  });
});

describe('resolveEmbeddingModel — error handling', () => {
  it('throws with clear message listing updated valid-preset list on unknown preset', () => {
    const err = () => resolveEmbeddingModel({ EMBEDDING_PRESET: 'englisch' });
    expect(err).toThrow(/Unknown EMBEDDING_PRESET='englisch'/);
    expect(err).toThrow(/Valid presets: english, english-fast, english-quality, multilingual, multilingual-quality, multilingual-ollama/);
  });

  it('throws with power-user hint on unknown preset', () => {
    expect(() => resolveEmbeddingModel({ EMBEDDING_PRESET: 'nope' }))
      .toThrow(/EMBEDDING_MODEL.*power-user path/);
  });
});

describe('resolveEmbeddingProvider', () => {
  it('returns ollama for multilingual-ollama preset', () => {
    expect(resolveEmbeddingProvider({ EMBEDDING_PRESET: 'multilingual-ollama' })).toBe('ollama');
  });

  it('returns transformers for english preset', () => {
    expect(resolveEmbeddingProvider({ EMBEDDING_PRESET: 'english' })).toBe('transformers');
  });

  it('honours EMBEDDING_PROVIDER env override even for multilingual-ollama', () => {
    expect(resolveEmbeddingProvider({ EMBEDDING_PRESET: 'multilingual-ollama', EMBEDDING_PROVIDER: 'transformers' })).toBe('transformers');
  });

  it('returns transformers when EMBEDDING_MODEL is set', () => {
    expect(resolveEmbeddingProvider({ EMBEDDING_MODEL: 'BAAI/bge-m3' })).toBe('transformers');
  });
});

describe('EMBEDDING_PRESETS table', () => {
  it('has exactly 6 canonical presets', () => {
    expect(Object.keys(EMBEDDING_PRESETS)).toHaveLength(6);
  });

  it('english preset is ≤60 MB (default-tier)', () => {
    expect(EMBEDDING_PRESETS['english'].sizeMb).toBeLessThanOrEqual(60);
  });

  it('english-fast preset is ≤60 MB (default-tier)', () => {
    expect(EMBEDDING_PRESETS['english-fast'].sizeMb).toBeLessThanOrEqual(60);
  });

  it('english-quality preset is >60 MB (quality-tier)', () => {
    expect(EMBEDDING_PRESETS['english-quality'].sizeMb).toBeGreaterThan(60);
  });

  it('multilingual preset is >60 MB (quality-tier)', () => {
    expect(EMBEDDING_PRESETS['multilingual'].sizeMb).toBeGreaterThan(60);
  });

  it('multilingual-quality preset is >200 MB', () => {
    expect(EMBEDDING_PRESETS['multilingual-quality'].sizeMb).toBeGreaterThan(200);
  });

  it('multilingual-ollama has no sizeMb (Ollama-side model)', () => {
    expect(EMBEDDING_PRESETS['multilingual-ollama'].sizeMb).toBeNull();
  });

  it('multilingual-ollama model is bge-m3', () => {
    expect(EMBEDDING_PRESETS['multilingual-ollama'].model).toBe('bge-m3');
  });

  it('multilingual-ollama is symmetric (no prefix needed)', () => {
    expect(EMBEDDING_PRESETS['multilingual-ollama'].symmetric).toBe(true);
  });

  it('multilingual-ollama has 1024 dimensions', () => {
    expect(EMBEDDING_PRESETS['multilingual-ollama'].dim).toBe(1024);
  });

  it('english preset is asymmetric (BGE uses query/passage prefix)', () => {
    expect(EMBEDDING_PRESETS['english'].symmetric).toBe(false);
  });

  it('english-fast preset is symmetric (MiniLM, no prefix)', () => {
    expect(EMBEDDING_PRESETS['english-fast'].symmetric).toBe(true);
  });
});
