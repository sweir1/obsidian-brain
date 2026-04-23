import { z } from 'zod';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';
import { previewStore } from './preview-store.js';

export function registerApplyEditPreviewTool(server: McpServer, ctx: ServerContext): void {
  registerTool(
    server,
    'apply_edit_preview',
    'Apply a previously previewed edit. Pass the `previewId` returned by `edit_note` with `dryRun: true`. Previews expire after 5 minutes. Fails with a descriptive error if the target file changed since the preview was generated — in that case, regenerate the preview and try again.',
    { previewId: z.string().describe('The previewId returned by `edit_note` with `dryRun: true`.') },
    async (args) => {
      const preview = previewStore.get(args.previewId);
      if (!preview) {
        throw new Error(
          `Preview "${args.previewId}" not found or expired (TTL: 5 minutes). Re-run the original edit_note call with dryRun: true to generate a fresh preview.`,
        );
      }

      const abs = join(ctx.config.vaultPath, preview.path);
      const currentContent = await fs.readFile(abs, 'utf-8');
      if (currentContent !== preview.originalContent) {
        throw new Error(
          `File "${preview.path}" has changed since the preview was generated. Re-run edit_note with dryRun: true to get a fresh preview.`,
        );
      }

      const tmp = `${abs}.tmp`;
      await fs.writeFile(tmp, preview.proposedContent, 'utf-8');
      await fs.rename(tmp, abs);

      previewStore.delete(args.previewId);

      const bytesWritten = Buffer.byteLength(preview.proposedContent, 'utf-8');

      try {
        await ctx.ensureEmbedderReady();
        await ctx.pipeline.index(ctx.config.vaultPath);
      } catch (err) {
        return {
          path: preview.path,
          bytesWritten,
          mode: preview.mode,
          reindex: 'failed',
          reindexError: String(err),
        };
      }

      return {
        path: preview.path,
        bytesWritten,
        mode: preview.mode,
        diff: preview.diff,
      };
    },
  );
}
