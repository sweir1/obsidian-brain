import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';
import { resolveNodeName } from '../resolve/name-match.js';
import { editNote, type EditMode } from '../vault/editor.js';

/**
 * `edit_note` — in-place edits against an existing note. Six modes map onto
 * the `EditMode` tagged union in `vault/editor.ts`. Required-field checks
 * per mode fail loudly instead of shipping `undefined` into the editor.
 */
export function registerEditNoteTool(server: McpServer, ctx: ServerContext): void {
  registerTool(
    server,
    'edit_note',
    "Modify an existing note. Supports six edit modes: append (add to end; defensively inserts a leading newline if the source didn't end with one), prepend (insert after frontmatter if present, otherwise at file start), replace_window (find a block of text and replace it — optionally fuzzy; fuzzy extends match to consume trailing .?! so the replacement has no doubled punctuation), patch_heading (insert or replace content under a specific heading; `headingOp: 'before' | 'after'` inserts immediately before/after the heading line — use `before` on the NEXT heading to append to a section's end; `headingOp: 'replace'` with `scope: 'section'` (default) replaces to the next same-or-higher heading or EOF — CAREFUL on the LAST heading, this consumes everything below including content separated by blank lines — pass `scope: 'body'` to stop at the first blank line after the body; if the target heading text appears MORE THAN ONCE the call throws MultipleMatches listing each occurrence with its line number — pass `headingIndex: 0 | 1 | ...` (0-indexed, top-to-bottom) to pick one), patch_frontmatter (set a single YAML key; pass `value: null` to clear — or from XML-stringifying clients use `valueJson: 'null'` for true null, `valueJson: 'true'` for a real boolean, `valueJson: '42'` for a number, `valueJson: '[\"a\"]'` for an array; `valueJson` wins over `value` when both are set), at_line (insert or replace at a 1-indexed line number that counts from file start including frontmatter lines).",
    {
      name: z.string(),
      mode: z.enum([
        'append',
        'prepend',
        'replace_window',
        'patch_heading',
        'patch_frontmatter',
        'at_line',
      ]),
      content: z.string().optional(),
      search: z.string().optional(),
      fuzzy: z.boolean().optional(),
      heading: z.string().optional(),
      headingOp: z.enum(['replace', 'before', 'after']).optional(),
      scope: z.enum(['section', 'body']).optional(),
      headingIndex: z.number().int().nonnegative().optional(),
      key: z.string().optional(),
      value: z.unknown().optional(),
      valueJson: z.string().optional(),
      line: z.number().int().positive().optional(),
      lineOp: z.enum(['before', 'after', 'replace']).optional(),
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

      const editMode = buildEditMode(args);
      const result = await editNote(ctx.config.vaultPath, first.nodeId, editMode);

      const payload: {
        path: string;
        mode: string;
        diff: { before: string; after: string };
        bytesWritten: number;
        removedLen?: number;
      } = {
        path: result.path,
        mode: args.mode,
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
  heading?: string;
  headingOp?: 'replace' | 'before' | 'after';
  scope?: 'section' | 'body';
  headingIndex?: number;
  key?: string;
  value?: unknown;
  valueJson?: string;
  line?: number;
  lineOp?: 'before' | 'after' | 'replace';
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
