import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { upsertNode } from '../../src/store/nodes.js';
import { parseValueJson, registerEditNoteTool } from '../../src/tools/edit-note.js';
import type { ServerContext } from '../../src/context.js';

describe('parseValueJson (F12 harness-compat)', () => {
  it('parses JSON null into real null', () => {
    expect(parseValueJson('null')).toBeNull();
  });

  it('parses JSON true into boolean', () => {
    expect(parseValueJson('true')).toBe(true);
  });

  it('parses JSON number', () => {
    expect(parseValueJson('42')).toBe(42);
  });

  it('parses JSON array', () => {
    expect(parseValueJson('["a","b"]')).toEqual(['a', 'b']);
  });

  it('parses JSON object', () => {
    expect(parseValueJson('{"k":1}')).toEqual({ k: 1 });
  });

  it('parses JSON string', () => {
    expect(parseValueJson('"hello"')).toBe('hello');
  });

  it('throws a clear error on invalid JSON', () => {
    expect(() => parseValueJson('{not json')).toThrow(
      /valueJson is not valid JSON/,
    );
  });
});

// ---------------------------------------------------------------------------
// dryRun=true — file unchanged, preview returned (v1.6.0-B)
// ---------------------------------------------------------------------------

interface RecordedTool {
  name: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  cb: (args: any) => Promise<any>;
}

function makeMockServer(): { server: any; registered: RecordedTool[] } {
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrap(result: any): any {
  expect(result.isError).toBeFalsy();
  return JSON.parse(result.content[0].text);
}

describe('edit_note dryRun=true returns preview without writing (v1.6.0-B)', () => {
  let vault: string;
  let db: DatabaseHandle;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'kg-edit-dryrun-'));
    db = openDb(':memory:');
  });

  afterEach(async () => {
    db.close();
    await rm(vault, { recursive: true, force: true });
  });

  function buildCtx(): ServerContext {
    return {
      db,
      config: { vaultPath: vault },
      ensureEmbedderReady: async () => {},
      pipeline: { index: async () => undefined },
    } as unknown as ServerContext;
  }

  it('mode=append with dryRun=true returns previewId and diff, file is unchanged on disk', async () => {
    const fileRel = 'draft.md';
    const original = '# Draft\n\nSome content.\n';
    await writeFile(join(vault, fileRel), original, 'utf-8');
    upsertNode(db, { id: fileRel, title: 'Draft', content: '', frontmatter: {} });

    const { server, registered } = makeMockServer();
    registerEditNoteTool(server, buildCtx());
    const tool = registered.find((t) => t.name === 'edit_note')!;

    const payload = unwrap(
      await tool.cb({ name: fileRel, mode: 'append', content: 'X', dryRun: true }),
    );

    // Response shape.
    expect(payload.dryRun).toBe(true);
    expect(payload.previewId).toMatch(/^prev_/);
    expect(payload.path).toBe(fileRel);
    expect(payload.mode).toBe('append');
    expect(typeof payload.diff).toBe('string');
    expect(payload.diff).toContain('+X');

    // File must NOT have been mutated.
    const afterContent = await readFile(join(vault, fileRel), 'utf-8');
    expect(afterContent).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// edit_note bulk edits (v1.6.0-E)
// ---------------------------------------------------------------------------

describe('edit_note bulk edits (v1.6.0-E)', () => {
  let vault: string;
  let db: DatabaseHandle;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'kg-edit-bulk-'));
    db = openDb(':memory:');
  });

  afterEach(async () => {
    db.close();
    await rm(vault, { recursive: true, force: true });
  });

  function buildCtx(): ServerContext {
    return {
      db,
      config: { vaultPath: vault },
      ensureEmbedderReady: async () => {},
      pipeline: { index: async () => undefined },
    } as unknown as ServerContext;
  }

  it('applies all edits atomically, returns editsApplied, file content verified', async () => {
    const fileRel = 'multi.md';
    const original = '# Note\n\nOriginal body.\n';
    await writeFile(join(vault, fileRel), original, 'utf-8');
    upsertNode(db, { id: fileRel, title: 'Note', content: '', frontmatter: {} });

    const { server, registered } = makeMockServer();
    registerEditNoteTool(server, buildCtx());
    const tool = registered.find((t) => t.name === 'edit_note')!;

    const payload = unwrap(
      await tool.cb({
        name: fileRel,
        edits: [
          { mode: 'append', content: '\nAppended line.\n' },
          { mode: 'replace_window', search: 'Original body.', content: 'Updated body.' },
        ],
      }),
    );

    expect(payload.mode).toBe('bulk');
    expect(payload.editsApplied).toBe(2);
    expect(payload.bytesWritten).toBeGreaterThan(0);

    const disk = await readFile(join(vault, fileRel), 'utf-8');
    expect(disk).toContain('Updated body.');
    expect(disk).toContain('Appended line.');
    expect(disk).not.toContain('Original body.');
  });

  it('leaves file unchanged and names edits[1] when second edit fails', async () => {
    const fileRel = 'stable.md';
    const original = '# Stable\n\nContent here.\n';
    await writeFile(join(vault, fileRel), original, 'utf-8');
    upsertNode(db, { id: fileRel, title: 'Stable', content: '', frontmatter: {} });

    const { server, registered } = makeMockServer();
    registerEditNoteTool(server, buildCtx());
    const tool = registered.find((t) => t.name === 'edit_note')!;

    const result = await tool.cb({
      name: fileRel,
      edits: [
        { mode: 'append', content: '\nExtra.\n' },
        { mode: 'replace_window', search: 'DOES_NOT_EXIST', content: 'nope' },
      ],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/edits\[1\]/);

    // File must be unchanged.
    const disk = await readFile(join(vault, fileRel), 'utf-8');
    expect(disk).toBe(original);
  });

  it('dryRun=true with edits returns previewId without writing file', async () => {
    const fileRel = 'preview.md';
    const original = '# Preview\n\nOriginal.\n';
    await writeFile(join(vault, fileRel), original, 'utf-8');
    upsertNode(db, { id: fileRel, title: 'Preview', content: '', frontmatter: {} });

    const { server, registered } = makeMockServer();
    registerEditNoteTool(server, buildCtx());
    const tool = registered.find((t) => t.name === 'edit_note')!;

    const payload = unwrap(
      await tool.cb({
        name: fileRel,
        dryRun: true,
        edits: [
          { mode: 'append', content: '\nNew section.\n' },
        ],
      }),
    );

    expect(payload.dryRun).toBe(true);
    expect(payload.previewId).toMatch(/^prev_/);
    expect(payload.mode).toBe('bulk');
    expect(payload.editsApplied).toBe(1);
    expect(typeof payload.diff).toBe('string');
    expect(payload.diff).toContain('+New section.');

    // File must NOT have been written.
    const disk = await readFile(join(vault, fileRel), 'utf-8');
    expect(disk).toBe(original);
  });
});
