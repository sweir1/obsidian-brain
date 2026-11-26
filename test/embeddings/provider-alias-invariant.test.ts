import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  OPENAI_COMPATIBLE_ALIASES,
  OPENAI_COMPATIBLE_ALIAS_LIST,
  resolveEmbeddingProvider,
} from '../../src/embeddings/presets.js';

/**
 * Alias-drift invariant: the set of spellings `_parseExplicitProvider` accepts
 * is the single source of truth, and three user-facing surfaces restate it —
 * the `server.json` schema, the error message, and docs/embeddings.md. Each
 * one drifted once already (`llama-cpp` and `lm-studio` were accepted by the
 * runtime but absent from all three), which either blocks a valid value in a
 * schema-driven UI or tells the user a working spelling is invalid.
 */
describe('EMBEDDING_PROVIDER aliases — drift invariant', () => {
  const CANONICAL = ['transformers', 'ollama', 'openai-compatible'];

  it('every accepted spelling actually resolves to openai-compatible', () => {
    for (const alias of OPENAI_COMPATIBLE_ALIASES) {
      expect(
        resolveEmbeddingProvider({ EMBEDDING_PROVIDER: alias } as NodeJS.ProcessEnv),
        `'${alias}' is in the alias set but does not resolve`,
      ).toBe('openai-compatible');
    }
  });

  it('server.json choices match the accepted set exactly', () => {
    const schema = JSON.parse(readFileSync('server.json', 'utf8'));
    const env = schema.packages[0].environmentVariables.find(
      (e: { name: string }) => e.name === 'EMBEDDING_PROVIDER',
    );
    expect(env, 'EMBEDDING_PROVIDER missing from server.json').toBeDefined();

    const expected = new Set([...CANONICAL, ...OPENAI_COMPATIBLE_ALIAS_LIST]);
    expect(
      new Set(env.choices),
      'server.json choices drifted from OPENAI_COMPATIBLE_ALIASES',
    ).toEqual(expected);
  });

  it('server.json description names every alias', () => {
    const schema = JSON.parse(readFileSync('server.json', 'utf8'));
    const env = schema.packages[0].environmentVariables.find(
      (e: { name: string }) => e.name === 'EMBEDDING_PROVIDER',
    );
    for (const alias of OPENAI_COMPATIBLE_ALIAS_LIST) {
      expect(env.description, `'${alias}' undocumented in server.json`).toContain(alias);
    }
  });

  it('the unknown-provider error names every alias', () => {
    let message = '';
    try {
      resolveEmbeddingProvider({ EMBEDDING_PROVIDER: 'definitely-not-a-provider' } as NodeJS.ProcessEnv);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message, 'expected an Unknown EMBEDDING_PROVIDER error').toContain(
      'Unknown EMBEDDING_PROVIDER',
    );
    for (const alias of OPENAI_COMPATIBLE_ALIAS_LIST) {
      expect(message, `'${alias}' missing from the error message`).toContain(alias);
    }
  });

  it('docs/embeddings.md lists every accepted spelling', () => {
    const md = readFileSync('docs/embeddings.md', 'utf8');
    const block = md.match(
      /These spellings are\s+all accepted and equivalent:([\s\S]*?)\.\n/,
    );
    expect(block, 'alias block missing from docs/embeddings.md').not.toBeNull();
    for (const alias of OPENAI_COMPATIBLE_ALIASES) {
      expect(block![1], `'${alias}' undocumented in docs/embeddings.md`).toContain(`\`${alias}\``);
    }
  });
});
