import { promises as fs } from 'fs';
import { basename, join } from 'path';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';
import type { DatabaseHandle } from '../store/db.js';
import { resolveNodeName } from '../resolve/name-match.js';
import { moveNote } from '../vault/mover.js';
import { rewriteWikiLinks } from '../vault/wiki-links.js';
import { getEdgesByTarget } from '../store/edges.js';
import { allNodeIds, getNode, migrateStubToReal, pruneOrphanStubs } from '../store/nodes.js';
import { renameNode } from '../store/rename.js';
import { setSyncMtime } from '../store/sync.js';

/**
 * Compute what `rewriteInboundLinks` would do without writing anything.
 * Returns per-file occurrence counts for every inbound source of `oldPath`.
 */
async function previewInboundRewrites(
  db: DatabaseHandle,
  vaultPath: string,
  oldPath: string,
  newPath: string,
): Promise<Array<{ file: string; occurrences: number }>> {
  const oldStem = basename(oldPath, '.md');
  const newStem = basename(newPath, '.md');
  if (oldStem === newStem) return [];

  // Also pick up edges pointing at the matching stub path. Pre-v1.5.8 vaults
  // and forward-ref-stubs that were never migrated to real keep their edges
  // on `_stub/${oldStem}.md` — rewriting those source files needs them too.
  const stubPath = `_stub/${oldStem}.md`;
  const inbound = [
    ...getEdgesByTarget(db, oldPath),
    ...getEdgesByTarget(db, stubPath),
  ];
  const sources = new Set(inbound.map((e) => e.sourceId));
  sources.delete(oldPath);
  sources.delete(newPath);

  const results: Array<{ file: string; occurrences: number }> = [];
  for (const sourceRel of sources) {
    const abs = join(vaultPath, sourceRel);
    let content: string;
    try {
      content = await fs.readFile(abs, 'utf-8');
    } catch {
      continue;
    }
    const { occurrences } = rewriteWikiLinks(content, oldStem, newStem);
    if (occurrences > 0) {
      results.push({ file: sourceRel, occurrences });
    }
  }
  return results;
}

/**
 * `move_note` — rename/move a note on disk. After the move, any note that
 * linked to the old stem has its wiki-links rewritten in place so the vault
 * stays consistent without waiting for the next re-index.
 *
 * Returns `{ oldPath, newPath, linksRewritten: { files, occurrences } }`.
 */
export function registerMoveNoteTool(server: McpServer, ctx: ServerContext): void {
  registerTool(
    server,
    'move_note',
    "Rename or move a note. Inbound wiki-links in other notes are rewritten in place immediately (bare [[old]], [[old|alias]], ![[old]] embeds, and [[old#heading]]/[[old^block]] suffixes all handled). If the note's frontmatter has a `title:` field matching the old basename, it's auto-rewritten to the new basename (custom titles and missing titles are left alone). Response includes `linksRewritten: { files, occurrences }`.",
    {
      source: z.string(),
      destination: z.string().min(1),
      dryRun: z.boolean().optional(),
    },
    async (args) => {
      const { source, destination, dryRun } = args;

      const fileRelPath = resolveToSinglePath(source, ctx);

      if (dryRun === true) {
        // Compute what would happen without mutating anything.
        const oldPath = fileRelPath;
        // Mirror moveNote's normalizeDestination: append .md when no dot in
        // the final segment; trailing-slash directories are not common for
        // dryRun callers, so we apply only the simple rule here.
        const last = destination.split(/[/\\]/).pop() ?? '';
        const newPath = last.includes('.') ? destination : destination + '.md';
        const linksToRewrite = await previewInboundRewrites(
          ctx.db,
          ctx.config.vaultPath,
          oldPath,
          newPath,
        );
        const totalFiles = linksToRewrite.length;
        const totalOccurrences = linksToRewrite.reduce((sum, r) => sum + r.occurrences, 0);
        return { dryRun: true, oldPath, newPath, linksToRewrite, totalFiles, totalOccurrences };
      }

      const result = await moveNote(ctx.config.vaultPath, fileRelPath, destination);

      // Rewrite source-file content on disk FIRST — this reads edges keyed
      // on the old path, so it must run before renameNode repoints them.
      const linksRewritten = await rewriteInboundLinks(
        ctx.db,
        ctx.config.vaultPath,
        result.oldPath,
        result.newPath,
      );

      // Atomic DB-level rename: every row keyed on the old path — edges
      // (in and out), chunks (+ composite ids), sync entry, community
      // membership — is rewritten in place. Inbound edges survive the
      // rename instead of being deleted and re-derived from the reparse.
      renameNode(ctx.db, result.oldPath, result.newPath);

      // If a forward-reference stub for the old stem still has inbound
      // edges (e.g. a source that linked through `_stub/${oldStem}.md` that
      // wasn't migrated yet), absorb its inbound edges onto the renamed
      // real node so no ghost edge is left behind.
      const oldStem = basename(result.oldPath, '.md');
      const stubPath = `_stub/${oldStem}.md`;
      if (getNode(ctx.db, stubPath)) {
        migrateStubToReal(ctx.db, stubPath, result.newPath);
      }

      // Force the next reindex pass to reparse every rewritten source. On
      // filesystems with 1-second mtime resolution, a fast rewrite could
      // land in the same integer second as the previously-recorded mtime
      // and `applyNode`'s `prevMtime >= mtime` check would skip it, leaving
      // edges stale. Zeroing the sync mtime guarantees reparse.
      for (const src of linksRewritten.rewrittenSources) {
        setSyncMtime(ctx.db, src, 0);
      }

      const stubCandidates = allNodeIds(ctx.db).filter((id) =>
        id.startsWith(`_stub/${oldStem}`),
      );
      const stubsPruned = pruneOrphanStubs(ctx.db, stubCandidates);

      try {
        await ctx.ensureEmbedderReady();
        await ctx.pipeline.index(ctx.config.vaultPath);
      } catch (err) {
        return {
          ...result,
          linksRewritten: { files: linksRewritten.files, occurrences: linksRewritten.occurrences },
          stubsPruned,
          reindex: 'failed',
          reindexError: String(err),
        };
      }

      return {
        ...result,
        linksRewritten: { files: linksRewritten.files, occurrences: linksRewritten.occurrences },
        stubsPruned,
      };
    },
  );
}

/**
 * Find every source file that linked to `oldPath` before the move and rewrite
 * those wiki-links from the old stem to the new stem. Source files missing on
 * disk are skipped silently — the index may be momentarily out of sync with a
 * user's out-of-band deletion, and a failure there shouldn't fail the move.
 *
 * Exported for testability; not part of the public tool surface.
 */
export async function rewriteInboundLinks(
  db: DatabaseHandle,
  vaultPath: string,
  oldPath: string,
  newPath: string,
): Promise<{ files: number; occurrences: number; rewrittenSources: string[] }> {
  const oldStem = basename(oldPath, '.md');
  const newStem = basename(newPath, '.md');

  // A rename that only changes the directory leaves every link intact.
  if (oldStem === newStem) return { files: 0, occurrences: 0, rewrittenSources: [] };

  // Also pick up edges whose target is the matching stub path. These can be
  // left over from forward-ref stubs that were never migrated to real — old
  // vault state (pre-v1.5.8) or notes created via the watcher path. Without
  // this merge, source files that linked through the stub never get rewritten.
  const stubPath = `_stub/${oldStem}.md`;
  const inbound = [
    ...getEdgesByTarget(db, oldPath),
    ...getEdgesByTarget(db, stubPath),
  ];
  const sources = new Set(inbound.map((e) => e.sourceId));
  // Moving a note can't break a link from itself, but skip defensively.
  sources.delete(oldPath);
  sources.delete(newPath);

  let files = 0;
  let occurrences = 0;
  const rewrittenSources: string[] = [];
  for (const sourceRel of sources) {
    const abs = join(vaultPath, sourceRel);
    let content: string;
    try {
      content = await fs.readFile(abs, 'utf-8');
    } catch {
      continue;
    }
    const { text, occurrences: hits } = rewriteWikiLinks(content, oldStem, newStem);
    if (hits > 0) {
      await fs.writeFile(abs, text, 'utf-8');
      files++;
      occurrences += hits;
      rewrittenSources.push(sourceRel);
    }
  }
  return { files, occurrences, rewrittenSources };
}

function resolveToSinglePath(name: string, ctx: ServerContext): string {
  const matches = resolveNodeName(name, ctx.db);
  if (matches.length === 0) {
    throw new Error(`No note found matching "${name}"`);
  }
  const first = matches[0]!;
  const ambiguous =
    matches.length > 1 &&
    (first.matchType === 'substring' ||
      first.matchType === 'case-insensitive' ||
      first.matchType === 'alias');
  if (ambiguous) {
    const candidates = matches
      .slice(0, 10)
      .map((m) => `- ${m.title} (${m.nodeId})`)
      .join('\n');
    throw new Error(
      `Multiple notes match "${name}". Please be more specific. Candidates:\n${candidates}`,
    );
  }
  return first.nodeId;
}
