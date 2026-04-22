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
import { allNodeIds, pruneOrphanStubs } from '../store/nodes.js';

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
    },
    async (args) => {
      const { source, destination } = args;

      const fileRelPath = resolveToSinglePath(source, ctx);
      const result = await moveNote(ctx.config.vaultPath, fileRelPath, destination);

      const linksRewritten = await rewriteInboundLinks(
        ctx.db,
        ctx.config.vaultPath,
        result.oldPath,
        result.newPath,
      );

      const oldStem = basename(result.oldPath, '.md');
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
          linksRewritten,
          stubsPruned,
          reindex: 'failed',
          reindexError: String(err),
        };
      }

      return { ...result, linksRewritten, stubsPruned };
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
): Promise<{ files: number; occurrences: number }> {
  const oldStem = basename(oldPath, '.md');
  const newStem = basename(newPath, '.md');

  // A rename that only changes the directory leaves every link intact.
  if (oldStem === newStem) return { files: 0, occurrences: 0 };

  const inbound = getEdgesByTarget(db, oldPath);
  const sources = new Set(inbound.map((e) => e.sourceId));
  // Moving a note can't break a link from itself, but skip defensively.
  sources.delete(oldPath);
  sources.delete(newPath);

  let files = 0;
  let occurrences = 0;
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
    }
  }
  return { files, occurrences };
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
