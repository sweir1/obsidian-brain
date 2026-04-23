import { z } from 'zod';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createPatch } from 'diff';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';
import { resolveNodeName } from '../resolve/name-match.js';
import { editNote, bulkEditNote, applyEdit, type EditMode } from '../vault/editor.js';
import { previewStore } from './preview-store.js';
import { editBuffer } from './edit-buffer.js';

const BulkEditItemSchema = z.object({
  mode: z.enum(['append', 'prepend', 'replace_window', 'patch_heading', 'patch_frontmatter', 'at_line']),
  content: z.string().optional(),
  search: z.string().optional(),
  fuzzy: z.boolean().optional(),
  fuzzyThreshold: z.number().min(0).max(1).optional(),
  heading: z.string().optional(),
  headingOp: z.enum(['replace', 'before', 'after']).optional(),
  scope: z.enum(['section', 'body']).optional(),
  headingIndex: z.number().int().nonnegative().optional(),
  key: z.string().optional(),
  value: z.unknown().optional(),
  valueJson: z.string().optional(),
  line: z.number().int().positive().optional(),
  lineOp: z.enum(['before', 'after', 'replace']).optional(),
});

/**
 * `edit_note` — in-place edits against an existing note. Six modes map onto
 * the `EditMode` tagged union in `vault/editor.ts`. Required-field checks
 * per mode fail loudly instead of shipping `undefined` into the editor.
 */
export function registerEditNoteTool(server: McpServer, ctx: ServerContext): void {
  registerTool(
    server,
    'edit_note',
    "Modify an existing note. Supports six edit modes: append (add to end; defensively inserts a leading newline if the source didn't end with one), prepend (insert after frontmatter if present, otherwise at file start), replace_window (find a block of text and replace it — optionally fuzzy; fuzzy extends match to consume trailing .?! so the replacement has no doubled punctuation), patch_heading (insert or replace content under a specific heading; `headingOp: 'before' | 'after'` inserts immediately before/after the heading line — use `before` on the NEXT heading to append to a section's end; `headingOp: 'replace'` with `scope: 'section'` (default) replaces to the next same-or-higher heading or EOF — CAREFUL on the LAST heading, this consumes everything below including content separated by blank lines — pass `scope: 'body'` to stop at the first blank line after the body; if the target heading text appears MORE THAN ONCE the call throws MultipleMatches listing each occurrence with its line number — pass `headingIndex: 0 | 1 | ...` (0-indexed, top-to-bottom) to pick one), patch_frontmatter (set a single YAML key; pass `value: null` to clear — or from XML-stringifying clients use `valueJson: 'null'` for true null, `valueJson: 'true'` for a real boolean, `valueJson: '42'` for a number, `valueJson: '[\"a\"]'` for an array; `valueJson` wins over `value` when both are set), at_line (insert or replace at a 1-indexed line number that counts from file start including frontmatter lines). Pass `edits` (array) to apply multiple edits atomically — all succeed or none are written.",
    {
      name: z.string().describe('Path or fuzzy match of the note to edit.'),
      mode: z.enum([
        'append',
        'prepend',
        'replace_window',
        'patch_heading',
        'patch_frontmatter',
        'at_line',
      ]).optional().describe('Edit mode. Required unless `edits` array is provided.'),
      content: z.string().optional().describe('New content to insert or replace (meaning is mode-dependent).'),
      search: z.string().optional().describe('For `replace_window`: the block of text to locate and replace.'),
      fuzzy: z.boolean().optional().describe('For `replace_window`: tolerate whitespace and trailing-punctuation drift.'),
      fuzzyThreshold: z.number().min(0).max(1).optional()
        .describe('Similarity threshold for fuzzy replace_window matches (0-1, default 0.7). Higher = stricter. 0.9 is recommended for typo-tolerant matching of known-good text.'),
      heading: z.string().optional().describe('Target heading text for `patch_heading` mode.'),
      headingOp: z.enum(['replace', 'before', 'after']).optional().describe('For `patch_heading`. `replace` (default) replaces section; `before`/`after` inserts adjacent to the heading line.'),
      scope: z.enum(['section', 'body']).optional().describe('For `patch_heading replace`: `section` (default) consumes to next same-or-higher heading; `body` stops at first blank line.'),
      headingIndex: z.number().int().nonnegative().optional().describe('For `patch_heading` when the heading appears more than once — 0-indexed top-to-bottom picker.'),
      key: z.string().optional().describe('For `patch_frontmatter`: the YAML key to set.'),
      value: z.unknown().optional().describe('For `patch_frontmatter`: value to set. Use `null` to clear a key. Prefer `valueJson` from clients that stringify params.'),
      valueJson: z.string().optional().describe('For `patch_frontmatter`: JSON-encoded value (wins over `value`). Use `"null"` to clear, `"true"` for boolean, `"42"` for number.'),
      line: z.number().int().positive().optional().describe('For `at_line`: 1-indexed line number (counts from file start including frontmatter).'),
      lineOp: z.enum(['before', 'after', 'replace']).optional().describe('For `at_line`: insert before/after the target line, or replace it. Default `replace`.'),
      dryRun: z.boolean().optional().describe(
        'If true, return a unified-diff preview without writing. Pass the returned previewId to apply_edit_preview to commit.',
      ),
      from_buffer: z.boolean().optional().describe(
        'If true, retry a previously failed replace_window edit using the cached content + search with fuzzy: true, fuzzyThreshold: 0.5. Use when the prior edit failed with NoMatch. Cleared on success.',
      ),
      edits: z.array(BulkEditItemSchema).optional().describe(
        'Array of edits to apply atomically to a single file. If any edit fails, no edit is written. Applied in order against the accumulated state (each edit sees the result of previous edits in the batch). Use replace_window / patch_heading for content-anchored edits; at_line references the accumulated state, not the original file.',
      ),
    },
    async (args) => {
      const matches = resolveNodeName(args.name, ctx.db);
      if (matches.length === 0) throw new Error(`No note found matching "${args.name}"`);
      const first = matches[0]!;
      const weak = first.matchType === 'substring'
        || first.matchType === 'case-insensitive'
        || first.matchType === 'alias';
      if (matches.length > 1 && weak) {
        const cands = matches.slice(0, 10).map((m) => `- ${m.title} (${m.nodeId})`).join('\n');
        throw new Error(`Multiple notes match "${args.name}". Please be more specific. Candidates:\n${cands}`);
      }

      // --- bulk edits branch: apply array of edits atomically ---
      if (args.edits !== undefined && args.edits.length > 0) {
        if (args.from_buffer === true) {
          throw new Error(
            'from_buffer is not compatible with bulk edits; re-issue the buffer retry as a single edit.',
          );
        }

        // Build EditMode array from each bulk item.
        const modes: EditMode[] = args.edits.map((item, i) => {
          try {
            return buildEditMode(item as EditArgs);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`edits[${i}]: ${msg}`);
          }
        });

        // dryRun + edits: compute final state, store preview, return without writing.
        if (args.dryRun === true) {
          const abs = join(ctx.config.vaultPath, first.nodeId);
          let original: string;
          try {
            original = await fs.readFile(abs, 'utf-8');
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`edit_note dryRun: could not read "${first.nodeId}": ${msg}`);
          }
          let proposed = original;
          for (let i = 0; i < modes.length; i++) {
            try {
              proposed = applyEdit(proposed, modes[i]).next;
            } catch (err) {
              const m = err instanceof Error ? err.message : String(err);
              throw new Error(`[bulk edit dryRun] edits[${i}] (${modes[i].kind}) failed: ${m}. No edits were applied.`);
            }
          }
          const diff = createPatch(first.nodeId, original, proposed, 'original', 'proposed');
          const previewId = `prev_${randomUUID()}`;
          previewStore.set({
            previewId,
            path: first.nodeId,
            originalContent: original,
            proposedContent: proposed,
            diff,
            mode: 'bulk',
            createdAt: Date.now(),
          });
          return { dryRun: true, previewId, path: first.nodeId, diff, mode: 'bulk', editsApplied: modes.length };
        }

        // Normal bulk apply.
        const bulkResult = await bulkEditNote(ctx.config.vaultPath, first.nodeId, modes);

        try {
          await ctx.ensureEmbedderReady();
          await ctx.pipeline.index(ctx.config.vaultPath);
        } catch (err) {
          return {
            path: bulkResult.path,
            mode: 'bulk',
            editsApplied: bulkResult.editsApplied,
            bytesWritten: bulkResult.bytesWritten,
            reindex: 'failed',
            reindexError: String(err),
          };
        }

        return {
          path: bulkResult.path,
          mode: 'bulk',
          editsApplied: bulkResult.editsApplied,
          bytesWritten: bulkResult.bytesWritten,
        };
      }
      // --- end bulk edits branch ---

      // --- from_buffer branch: retrieve buffered content and retry with fuzzy ---
      // Track whether this call is already a buffer-retry so we skip re-buffering
      // on failure (which would create a loop).
      const isBufferRetry = args.from_buffer === true;

      let editMode: EditMode;
      if (isBufferRetry) {
        const buffered = editBuffer.get(first.nodeId);
        if (!buffered) {
          throw new Error(
            `No buffered edit found for "${first.nodeId}". Buffer TTL is 30 minutes. Re-issue the edit with explicit content.`,
          );
        }
        editMode = {
          kind: 'replace_window' as const,
          search: buffered.search,
          content: buffered.content,
          fuzzy: true,
          fuzzyThreshold: 0.5,
        };
      } else {
        if (!args.mode) {
          throw new Error(`edit_note: 'mode' is required when 'edits' is not provided`);
        }
        editMode = buildEditMode(args as EditArgs);
      }
      // --- end from_buffer branch ---

      // --- dryRun branch: compute diff, store preview, return without writing ---
      if (args.dryRun === true) {
        const abs = join(ctx.config.vaultPath, first.nodeId);
        let original: string;
        try {
          original = await fs.readFile(abs, 'utf-8');
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(`edit_note dryRun: could not read "${first.nodeId}": ${msg}`);
        }
        const applied = applyEdit(original, editMode);
        const diff = createPatch(first.nodeId, original, applied.next, 'original', 'proposed');
        const previewId = `prev_${randomUUID()}`;
        previewStore.set({
          previewId,
          path: first.nodeId,
          originalContent: original,
          proposedContent: applied.next,
          diff,
          mode: args.mode as string,
          createdAt: Date.now(),
        });
        return { dryRun: true, previewId, path: first.nodeId, diff, mode: args.mode as string };
      }
      // --- end dryRun branch ---

      let result: Awaited<ReturnType<typeof editNote>>;
      try {
        result = await editNote(ctx.config.vaultPath, first.nodeId, editMode);
      } catch (err) {
        // On replace_window NoMatch failure: buffer the proposed content so
        // the agent can retry with `from_buffer: true` without re-emitting.
        // Only buffer non-retry calls (avoid infinite buffer churn).
        if (
          !isBufferRetry &&
          args.mode === 'replace_window' &&
          args.content !== undefined &&
          args.search !== undefined
        ) {
          editBuffer.push({
            path: first.nodeId,
            content: args.content,
            search: args.search,
            mode: args.mode,
            failedAt: Date.now(),
            error: err instanceof Error ? err.message : String(err),
          });
        }
        throw err;
      }

      // Clear the buffer on successful non-dryRun edit.
      editBuffer.remove(first.nodeId);

      // Also clear on from_buffer success (already covered by remove above,
      // but being explicit improves readability).

      const payload: {
        path: string;
        mode: string;
        diff: { before: string; after: string };
        bytesWritten: number;
        removedLen?: number;
      } = {
        path: result.path,
        mode: isBufferRetry ? 'replace_window' : (args.mode as string),
        diff: result.diff,
        bytesWritten: result.bytesWritten,
      };
      // Surface `removedLen` on replace-oriented modes so callers can detect
      // greedy consumption (specifically the default `patch_heading`
      // `scope: 'section'` eating to EOF on the last heading).
      if (args.mode === 'patch_heading') {
        payload.removedLen = result.removedLen;
      }

      try {
        await ctx.ensureEmbedderReady();
        await ctx.pipeline.index(ctx.config.vaultPath);
      } catch (err) {
        return { ...payload, reindex: 'failed', reindexError: String(err) };
      }

      return payload;
    },
  );
}

interface EditArgs {
  mode:
    | 'append'
    | 'prepend'
    | 'replace_window'
    | 'patch_heading'
    | 'patch_frontmatter'
    | 'at_line';
  content?: string;
  search?: string;
  fuzzy?: boolean;
  fuzzyThreshold?: number;
  heading?: string;
  headingOp?: 'replace' | 'before' | 'after';
  scope?: 'section' | 'body';
  headingIndex?: number;
  key?: string;
  value?: unknown;
  valueJson?: string;
  line?: number;
  lineOp?: 'before' | 'after' | 'replace';
  dryRun?: boolean;
  from_buffer?: boolean;
}

export function parseValueJson(valueJson: string): unknown {
  try {
    return JSON.parse(valueJson);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `edit_note mode=patch_frontmatter: valueJson is not valid JSON: ${message}`,
    );
  }
}

function need<T>(v: T | undefined, mode: string, field: string): T {
  if (v === undefined) throw new Error(`edit_note mode=${mode} requires '${field}'`);
  return v;
}

function buildEditMode(a: EditArgs): EditMode {
  switch (a.mode) {
    case 'append':
      return { kind: 'append', content: need(a.content, 'append', 'content') };
    case 'prepend':
      return { kind: 'prepend', content: need(a.content, 'prepend', 'content') };
    case 'replace_window':
      return {
        kind: 'replace_window',
        search: need(a.search, 'replace_window', 'search'),
        content: need(a.content, 'replace_window', 'content'),
        fuzzy: a.fuzzy,
        fuzzyThreshold: a.fuzzyThreshold,
      };
    case 'patch_heading':
      return {
        kind: 'patch_heading',
        heading: need(a.heading, 'patch_heading', 'heading'),
        content: need(a.content, 'patch_heading', 'content'),
        op: a.headingOp,
        scope: a.scope,
        headingIndex: a.headingIndex,
      };
    case 'patch_frontmatter': {
      // `valueJson` wins when both are set. It's the harness-compat path
      // for clients (e.g. claude.ai) that stringify all tool-call params.
      const value = a.valueJson !== undefined
        ? parseValueJson(a.valueJson)
        : a.value;
      return {
        kind: 'patch_frontmatter',
        key: need(a.key, 'patch_frontmatter', 'key'),
        value,
      };
    }
    case 'at_line':
      return {
        kind: 'at_line',
        line: need(a.line, 'at_line', 'line'),
        content: need(a.content, 'at_line', 'content'),
        op: a.lineOp,
      };
  }
}
