# MCP Server Development

## Transport Layer

MCP supports stdio, HTTP with Server-Sent Events, and WebSocket transports. Stdio is simplest for desktop integrations; HTTP suits multi-client scenarios.

## Tool Registration

### Schema Design

Each tool declares a Zod schema for its input. The SDK generates JSON Schema from it and includes the schema in the tools/list response so the client can validate inputs.

### Error Handling

Tools should throw `McpError` with a standard code (e.g., `ErrorCode.InvalidParams`) for user-visible errors, and re-throw unexpected errors as-is.
