import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';

const DEFAULT_BASE_TIMEOUT_MS = 30_000;

export function registerBaseQueryTool(
  server: McpServer,
  ctx: ServerContext,
): void {
  registerTool(
    server,
    'base_query',
    [
      "Evaluate an Obsidian Bases `.base` file and return its rows. Requires the obsidian-brain companion plugin installed, Obsidian 1.10.0+ running against the same vault, and the Bases core plugin enabled (Obsidian → Settings → Core plugins → Bases).",
      "Obsidian has no public API for running a base headlessly, so the plugin reads the `.base` YAML and evaluates it itself against Obsidian's metadata cache, following Obsidian's documented syntax: global and per-view `filters` (and / or / not), `note.` / `file.` / `formula.` properties, formulas, arithmetic and date ± duration, the common string, list, number, date and file functions (hasTag, inFolder, hasLink, hasProperty, …), and the view's `order`, `sort`, `limit`, `groupBy` and `groupOrder`. Like Obsidian, a base covers every file in the vault, not only notes. `this`, regular expressions and list `filter`/`map`/`reduce` return a 400 `unsupported_construct` naming the construct; a column formula that can't be computed comes back as null with a `warnings` entry. See docs/plugin.md#bases.",
      "Provide either `file` (vault-relative path to a .base file) or `yaml` (inline .base YAML source). `view` names the view to run; omit it to run the first view. Returns { view, rows, total, groupBy?, groups?, warnings?, executedAt } — each row has `file: {name, basename, path}` (`name` includes the extension) plus the view's `order:` columns, keyed by property id with any `note.` prefix dropped; dates are ISO strings. `total` is the count before `limit`.",
      "Default 30s timeout (override with timeoutMs). Timeout only cancels the HTTP wait; the plugin has no cancellation API, so a running evaluation keeps going inside Obsidian.",
    ].join(' '),
    {
      file: z
        .string()
        .optional()
        .describe(
          'Vault-relative path to a `.base` YAML file (e.g. "Bases/Books.base"). Either `file` or `yaml` is required.',
        ),
      yaml: z
        .string()
        .optional()
        .describe(
          'Inline `.base` YAML source. Either `file` or `yaml` is required.',
        ),
      view: z
        .string()
        .min(1)
        .optional()
        .describe(
          'The `name:` of the view to run, e.g. "Reading list". Omit to run the first view.',
        ),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'HTTP timeout in ms (default 30000). The plugin evaluator itself cannot be cancelled; this just bounds how long this tool waits.',
        ),
    },
    async (args) => {
      if (!args.file && !args.yaml) {
        throw new Error(
          'base_query: provide either `file` (vault-relative path to a .base file) or `yaml` (inline .base YAML source).',
        );
      }
      return ctx.obsidian.base(
        { file: args.file, yaml: args.yaml, ...(args.view ? { view: args.view } : {}) },
        { timeoutMs: args.timeoutMs ?? DEFAULT_BASE_TIMEOUT_MS },
      );
    },
  );
}
