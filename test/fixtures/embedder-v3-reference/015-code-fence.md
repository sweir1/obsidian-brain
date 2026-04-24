A minimal MCP server in TypeScript using the `@modelcontextprotocol/sdk`:

```typescript
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = new McpServer({ name: 'demo', version: '0.1.0' });

server.tool('echo', 'Echoes the input text', { text: z.string() }, async ({ text }) => ({
  content: [{ type: 'text', text }],
}));

const transport = new StdioServerTransport();
await server.connect(transport);
```

The server blocks on stdin and dispatches JSON-RPC requests to registered tool handlers until EOF.
