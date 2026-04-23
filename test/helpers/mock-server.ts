/**
 * Shared MCP mock-server helpers. Used by any test that wants to exercise a
 * tool's register* function without spinning a real MCP transport.
 *
 * registerTool-style tools push `{ name, description, schema, cb }` into the
 * server; this mock captures each call so the test can invoke `cb` directly.
 *
 * `unwrap` throws on `isError: true` so a surprise tool failure surfaces the
 * tool's own error text rather than an opaque JSON-parse crash on an empty
 * content array.
 */

export interface RecordedTool {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cb: (args: any) => Promise<any>;
}

export function makeMockServer(): { server: any; registered: RecordedTool[] } {
  const registered: RecordedTool[] = [];
  const server = {
    tool(
      name: string,
      _d: string,
      _s: unknown,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      cb: (args: any) => Promise<any>,
    ): void {
      registered.push({ name, cb });
    },
  };
  return { server, registered };
}

/** Unwrap the MCP content envelope. Throws if isError is set. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function unwrap(result: any): any {
  if (result.isError) {
    const text = result.content?.[0]?.text ?? '(no text)';
    throw new Error(`Tool returned isError=true: ${text}`);
  }
  return JSON.parse(result.content[0].text);
}
