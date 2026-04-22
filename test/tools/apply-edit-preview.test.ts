import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { upsertNode } from '../../src/store/nodes.js';
import { registerApplyEditPreviewTool } from '../../src/tools/apply-edit-preview.js';
import { registerEditNoteTool } from '../../src/tools/edit-note.js';
import { previewStore } from '../../src/tools/preview-store.js';
import type { ServerContext } from '../../src/context.js';

// ---------------------------------------------------------------------------
// Minimal mock server that captures registered tool callbacks.
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
      _desc: string,
      _schema: unknown,
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function unwrapError(result: any): string {
  expect(result.isError).toBe(true);
  return result.content[0].text as string;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('apply_edit_preview — end-to-end flow (v1.6.0-B)', () => {
  let vault: string;
  let db: DatabaseHandle;

  beforeEach(async () => {
    vault = await mkdtemp(join(tmpdir(), 'kg-apply-preview-'));
    db = openDb(':memory:');
    vi.useRealTimers();
  });

  afterEach(async () => {
    db.close();
    await rm(vault, { recursive: true, force: true });
    vi.useRealTimers();
  });

  function buildCtx(): ServerContext {
    return {
      db,
      config: { vaultPath: vault },
      ensureEmbedderReady: async () => {},
      pipeline: { index: async () => undefined },
    } as unknown as ServerContext;
  }

  it('happy path: dryRun → apply_edit_preview writes the file and clears the preview', async () => {
    const fileRel = 'happy.md';
    await writeFile(join(vault, fileRel), '# Hello\n', 'utf-8');
    upsertNode(db, { id: fileRel, title: 'Happy', content: '', frontmatter: {} });

    const ctx = buildCtx();
    const { server, registered } = makeMockServer();
    registerEditNoteTool(server, ctx);
    registerApplyEditPreviewTool(server, ctx);

    const editTool = registered.find((t) => t.name === 'edit_note')!;
    const applyTool = registered.find((t) => t.name === 'apply_edit_preview')!;

    // Step 1 — dry run.
    const preview = unwrap(
      await editTool.cb({ name: fileRel, mode: 'append', content: '\nAppended.', dryRun: true }),
    );
    expect(preview.dryRun).toBe(true);
    expect(preview.previewId).toMatch(/^prev_/);
    expect(preview.diff).toContain('Appended');

    // File must NOT have changed yet.
    expect(await readFile(join(vault, fileRel), 'utf-8')).toBe('# Hello\n');

    // Step 2 — apply.
    const applied = unwrap(await applyTool.cb({ previewId: preview.previewId }));
    expect(applied.path).toBe(fileRel);
    expect(applied.mode).toBe('append');
    expect(applied.bytesWritten).toBeGreaterThan(0);

    // File must now contain the appended content.
    const final = await readFile(join(vault, fileRel), 'utf-8');
    expect(final).toContain('Appended');

    // Preview must be gone.
    expect(previewStore.get(preview.previewId)).toBeUndefined();
  });

  it('expired / unknown previewId returns a descriptive error', async () => {
    const ctx = buildCtx();
    const { server, registered } = makeMockServer();
    registerApplyEditPreviewTool(server, ctx);
    const applyTool = registered.find((t) => t.name === 'apply_edit_preview')!;

    const result = await applyTool.cb({ previewId: 'prev_nonexistent' });
    const msg = unwrapError(result);
    expect(msg).toMatch(/not found or expired/i);
    expect(msg).toMatch(/5 minutes/i);
    expect(msg).toMatch(/dryRun: true/i);
  });

  it('file changed between preview and apply → descriptive error, file unchanged', async () => {
    const fileRel = 'changed.md';
    await writeFile(join(vault, fileRel), 'original content\n', 'utf-8');
    upsertNode(db, { id: fileRel, title: 'Changed', content: '', frontmatter: {} });

    const ctx = buildCtx();
    const { server, registered } = makeMockServer();
    registerEditNoteTool(server, ctx);
    registerApplyEditPreviewTool(server, ctx);

    const editTool = registered.find((t) => t.name === 'edit_note')!;
    const applyTool = registered.find((t) => t.name === 'apply_edit_preview')!;

    // Dry-run to get a preview.
    const preview = unwrap(
      await editTool.cb({ name: fileRel, mode: 'append', content: ' extra', dryRun: true }),
    );

    // Simulate an external change to the file between preview and apply.
    await writeFile(join(vault, fileRel), 'mutated content\n', 'utf-8');

    const result = await applyTool.cb({ previewId: preview.previewId });
    const msg = unwrapError(result);
    expect(msg).toMatch(/has changed since the preview/i);
    expect(msg).toMatch(/fresh preview/i);

    // File must still contain the mutated content (not the proposed content).
    expect(await readFile(join(vault, fileRel), 'utf-8')).toBe('mutated content\n');
  });
});
