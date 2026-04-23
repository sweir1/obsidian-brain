/**
 * Local helpers for editor test siblings. Each sibling declares its own
 * module-scope `let vault: string` and top-level `afterEach` cleanup —
 * that cannot be factored out because `afterEach` registers at module scope.
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { editNote, type EditMode } from '../../../src/vault/editor.js';

export const rel = 'note.md';

/**
 * Create a fresh tmpdir vault and seed note.md with `initial`. Returns the
 * vault path — callers assign it to their module-scope variable.
 */
export async function seedVault(initial: string): Promise<string> {
  const vault = await mkdtemp(join(tmpdir(), 'kg-editor-'));
  await writeFile(join(vault, rel), initial, 'utf-8');
  return vault;
}

/** Invoke editNote against the given vault + rel path. */
export const editAt = (vault: string, mode: EditMode) => editNote(vault, rel, mode);

/** Read the seeded note from a vault. */
export const readAt = (vault: string) => readFile(join(vault, rel), 'utf-8');
