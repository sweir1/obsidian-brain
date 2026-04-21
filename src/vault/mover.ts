/**
 * Move / rename / delete `.md` files inside the vault.
 *
 * Ported from the move/delete paths in aaronsb/obsidian-mcp-plugin's
 * `ObsidianAPI` (`renameFile`, `deleteFile`). The aaronsb version relies on
 * `app.vault.rename` / `app.fileManager.trashFile`, which handle link-
 * rewriting and trash semantics for free. This standalone implementation
 * uses plain `fs` calls and delegates link fix-up to the pipeline's
 * re-index pass (triggered by the tool layer in Phase 4).
 */

import { promises as fs } from 'fs';
import { dirname, join, basename, resolve } from 'path';
import type { DatabaseHandle } from '../store/db.js';
import { deleteEdgesBySource, countEdgesBySource } from '../store/edges.js';
import { deleteEmbedding } from '../store/embeddings.js';
import { deleteNode } from '../store/nodes.js';
import { deleteSyncPath } from '../store/sync.js';

export interface MoveResult {
  /** Vault-relative source path. */
  oldPath: string;
  /** Vault-relative destination path. */
  newPath: string;
}

export interface DeleteResult {
  /** Vault-relative path that was requested for deletion. */
  path: string;
  deletedFromIndex: {
    node: boolean;
    edges: number;
    embedding: boolean;
  };
}

/**
 * Rename or move a note.
 *
 * `destinationRel` is interpreted flexibly:
 *   - If it points to an existing directory, the source filename is kept.
 *   - If it ends with `/`, it's treated as a directory.
 *   - Otherwise it's treated as a full relative file path; `.md` is
 *     appended if the extension is missing.
 *
 * Intermediate directories are created. This function does NOT touch the
 * index — callers should trigger a re-scan afterwards.
 */
export async function moveNote(
  vaultPath: string,
  sourceRel: string,
  destinationRel: string,
): Promise<MoveResult> {
  const absSource = join(vaultPath, sourceRel);
  const resolvedSource = resolve(absSource);

  // Refuse to proceed if the source is missing — plain rename would surface
  // a cryptic ENOENT.
  await fs.stat(resolvedSource).catch(() => {
    throw new Error(`moveNote: source not found: ${sourceRel}`);
  });

  const destRelNorm = normalizeDestination(destinationRel, sourceRel);
  const absDest = join(vaultPath, destRelNorm);
  const resolvedDest = resolve(absDest);

  if (resolvedDest === resolvedSource) {
    return { oldPath: sourceRel, newPath: destRelNorm };
  }

  await fs.mkdir(dirname(resolvedDest), { recursive: true });
  await fs.rename(resolvedSource, resolvedDest);

  return { oldPath: sourceRel, newPath: destRelNorm };
}

/**
 * Normalise a caller-supplied destination into a vault-relative file path
 * ending in `.md`.
 */
function normalizeDestination(dest: string, sourceRel: string): string {
  const sourceFile = basename(sourceRel);

  // Trailing slash => directory, keep source filename.
  if (dest.endsWith('/') || dest.endsWith('\\')) {
    return joinRel(stripTrailingSep(dest), sourceFile);
  }

  // If no extension, treat the last segment as either a directory name or
  // a filename. We have no filesystem info at this point, so fall back to
  // the simple rule: no dot in final segment => treat as filename without
  // extension, so append `.md`.
  const last = dest.split(/[/\\]/).pop() ?? '';
  if (!last.includes('.')) {
    return dest + '.md';
  }

  // Has an extension but it isn't `.md`: still honour it verbatim — the
  // caller may want to rename to a non-markdown asset. In practice the
  // tool layer should validate this upstream.
  return dest;
}

function stripTrailingSep(p: string): string {
  return p.replace(/[/\\]+$/, '');
}

function joinRel(dir: string, name: string): string {
  if (dir === '' || dir === '.') return name;
  return `${dir}/${name}`;
}

/**
 * Delete a note and its index entries.
 *
 * Order: purge edges -> embedding -> node -> sync-path, then unlink the
 * file. If the file is already gone the index is still reconciled.
 *
 * Edge count is captured before deletion because `deleteEdgesBySource`
 * returns `void`.
 */
export async function deleteNote(
  vaultPath: string,
  fileRelPath: string,
  db: DatabaseHandle,
): Promise<DeleteResult> {
  const abs = join(vaultPath, fileRelPath);

  // Capture edge count before we nuke the row.
  let edgeCount = 0;
  try {
    edgeCount = countEdgesBySource(db, fileRelPath);
  } catch {
    // If the node isn't indexed at all this can fail silently.
    edgeCount = 0;
  }

  let nodeDeleted = false;
  let embeddingDeleted = false;
  try {
    deleteEdgesBySource(db, fileRelPath);
    try {
      deleteEmbedding(db, fileRelPath);
      embeddingDeleted = true;
    } catch {
      embeddingDeleted = false;
    }
    try {
      deleteNode(db, fileRelPath);
      nodeDeleted = true;
    } catch {
      nodeDeleted = false;
    }
    try {
      deleteSyncPath(db, fileRelPath);
    } catch {
      // sync table may not know about this path; non-fatal.
    }
  } catch (err) {
    // A failure in the index cleanup path shouldn't prevent us from
    // attempting the file unlink — surface the index status via the
    // return struct so the caller can react.
    // eslint-disable-next-line no-console
    console.warn(`deleteNote: index cleanup failed for ${fileRelPath}: ${String(err)}`);
  }

  // Finally, unlink the file. If it's already gone we still report success
  // for the index cleanup that did happen.
  try {
    await fs.unlink(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
  }

  return {
    path: fileRelPath,
    deletedFromIndex: {
      node: nodeDeleted,
      edges: edgeCount,
      embedding: embeddingDeleted,
    },
  };
}
