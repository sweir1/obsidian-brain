import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { registerTool } from './register.js';
import type { ServerContext } from '../context.js';

const DEFAULT_DV_TIMEOUT_MS = 30_000;

export function registerDataviewQueryTool(
  server: McpServer,
  ctx: ServerContext,
): void {
  registerTool(
    server,
    'dataview_query',
    [
      "Run a Dataview DQL query against the vault. Requires the obsidian-brain companion plugin v0.2.0+ installed, Obsidian running against the same vault, and the Dataview community plugin enabled.",
      "Returns a normalized discriminated-union shape. kind='table' gives {headers, rows}. kind='list' gives {values}. kind='task' gives {items: [{task, text, path, line, tags, children, ...STask fields when task=true}]}. kind='calendar' gives {events: [{date, link, value?}]}.",
      "DQL reference: https://blacksmithgu.github.io/obsidian-dataview/queries/structure/.",
      "Default 30s timeout (override with timeoutMs). NOTE: timeoutMs only cancels the HTTP wait; Dataview has no cancellation API, so the query keeps running inside Obsidian to completion. Prefer LIMIT N in DQL for open-ended queries.",
    ].join(' '),
    {
      query: z
        .string()
        .min(1)
        .describe(
          "DQL source, e.g. 'TABLE file.name, rating FROM #book WHERE status = \"reading\" LIMIT 50'",
        ),
      source: z
        .string()
        .optional()
        .describe(
          'Optional origin file path (vault-relative) to set the DQL origin. Affects `FROM ""` and relative link resolution inside the query.',
        ),
      timeoutMs: z
        .number()
        .int()
        .positive()
        .optional()
        .describe(
          'HTTP timeout in ms (default 30000). The Dataview query itself cannot be cancelled; this just bounds how long this tool waits.',
        ),
    },
    async (args) => {
      const timeoutMs = args.timeoutMs ?? DEFAULT_DV_TIMEOUT_MS;
      return ctx.obsidian.dataview(args.query, args.source, timeoutMs);
    },
  );
}
