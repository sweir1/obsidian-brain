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
      "Evaluate an Obsidian Bases `.base` file and return its rows. Requires the obsidian-brain companion plugin v1.4.0+ installed, Obsidian 1.10.0+ running against the same vault, and the Bases core plugin enabled (Obsidian → Settings → Core plugins → Bases).",
      "Obsidian does not yet expose a public API for headless Bases query execution (see `Plugin.registerBasesView()` is a view-factory hook only). The plugin uses its own YAML parser + a whitelisted expression subset (Path B). See docs/plugin.md#bases for the full supported subset.",
      "Supported v1.4.0 subset: tree ops (and/or/not), comparisons (==, !=, >, >=, <, <=), leaf boolean (&&, ||, !), file.{name, path, folder, ext, size, mtime, ctime, tags}, file.hasTag(\"x\"), file.inFolder(\"x\"), frontmatter dot-paths. Arithmetic (+, -, *, /, %), method calls other than hasTag/inFolder, function calls (today(), now(), etc.), regex literals, `formulas:`, `summaries:`, and `this` context references all return 400 unsupported_construct errors — they ship in v1.4.1 / v1.4.2 / v1.4.3 patches as users hit them.",
      "Provide either `file` (vault-relative path to a .base file) or `yaml` (inline .base YAML source); `view` names which view inside the file to execute. Returns { view, rows, total, executedAt } — rows contain {file: {name, path}, ...projected columns}, total is the pre-limit count.",
      "Default 30s timeout (override with timeoutMs). Timeout only cancels the HTTP wait; the plugin has no cancellation API, so a running evaluation keeps going inside Obsidian. Prefer a `limit:` in the view for open-ended queries over large vaults.",
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
        .describe(
          'The name of the view inside the `.base` file to execute, e.g. "active-books".',
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
        { file: args.file, yaml: args.yaml, view: args.view },
        { timeoutMs: args.timeoutMs ?? DEFAULT_BASE_TIMEOUT_MS },
      );
    },
  );
}
