MCP tool call error codes and their meanings:

| Error Code          | Numeric | Meaning                                        |
|---------------------|---------|------------------------------------------------|
| ParseError          | -32700  | Invalid JSON in request                        |
| InvalidRequest      | -32600  | JSON-RPC structure is invalid                  |
| MethodNotFound      | -32601  | Tool or method does not exist                  |
| InvalidParams       | -32602  | Input fails schema validation                  |
| InternalError       | -32603  | Unhandled server-side exception                |
| ResourceNotFound    | -32002  | Referenced resource URI not found              |

Clients should display the `message` field from the error object to help users diagnose failures.
