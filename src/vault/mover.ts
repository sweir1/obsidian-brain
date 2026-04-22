/**
 * Move / rename / delete `.md` files inside the vault.
 *
 * Ported from the move/delete paths in aaronsb/obsidian-mcp-plugin's
 * `ObsidianAPI` (`renameFile`, `deleteFile`). The aaronsb version relies on
 * `app.vault.rename` / `app.fileManager.trashFile`, which handle link-
 * rewriting and trash semantics for free. This standalone implementation
 * uses plain `fs` calls; inbound wiki-link rewriting on move is driven
 * eagerly by the `move_note` tool layer (`src/tools/move-note.ts`) using
 * the edge store + `rewriteWikiLinks` — this function itself only touches
 * the file being moved.
 */

import { promises as fs } from 'fs';
import { dirname, join, basename, resolve } from 'path';
import matter from 'gray-matter';
import type { DatabaseHandle } from '../store/db.js';
import { deleteEdgesBySource, countEdgesBySource, getEdgesBySource } from '../store/edges.js';
import { deleteEmbedding } from '../store/embeddings.js';
import { deleteNode, pruneOrphanStubs } from '../store/nodes.js';
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
    stubsPruned: number;
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

  // Keep `frontmatter.title` in sync with the filename when it was tracking
  // the old basename. If the user set a custom title (anything other than
  // the old basename), leave it alone. If there's no title key, don't add
  // one. Only touch `.md` files.
  if (destRelNorm.toLowerCase().endsWith('.md')) {
    await syncTitleToFilename(resolvedDest, sourceRel, destRelNorm).catch(() => {
      // Never fail a move just because we couldn't refresh the title.
    });
  }

  return { oldPath: sourceRel, newPath: destRelNorm };
}

/**
 * If the moved file's YAML frontmatter has `title` set to the old basename,
 * rewrite it to the new basename. Leaves custom titles and missing-title
 * files untouched.
 */
async function syncTitleToFilename(
  absDest: string,
  oldRel: string,
  newRel: string,
): Promise<void> {
  const raw = await fs.readFile(absDest, 'utf-8');
  let parsed: matter.GrayMatterFile<string>;
  try {
    parsed = matter(raw);
  } catch {
    return;
  }

  const data = parsed.data as Record<string, unknown>;
  if (typeof data.title !== 'string') return;

  const oldBase = basename(oldRel, '.md');
  const newBase = basename(newRel, '.md');
  if (data.title !== oldBase) return;

  const nextData = { ...data, title: newBase };
  const rewritten = matter.stringify(parsed.content, nextData);
  await fs.writeFile(absDest, rewritten, 'utf-8');
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

  // Capture outbound stub targets before edges are deleted so we can prune
  // any stubs that become orphaned after this note is removed.
  let stubTargetCandidates: string[] = [];
  try {
    const outbound = getEdgesBySource(db, fileRelPath);
    stubTargetCandidates = outbound
      .map((e) => e.targetId)
      .filter((id) => id.startsWith('_stub/'));
  } catch {
    stubTargetCandidates = [];
  }

  let nodeDeleted = false;
  let embeddingDeleted = false;
  let stubsPruned = 0;
  try {
    deleteEdgesBySource(db, fileRelPath);
    // After deleting outbound edges, prune any stubs that now have no
    // remaining inbound edges.
    try {
      stubsPruned = pruneOrphanStubs(db, stubTargetCandidates);
    } catch {
      stubsPruned = 0;
    }
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
      stubsPruned,
    },
  };
}
