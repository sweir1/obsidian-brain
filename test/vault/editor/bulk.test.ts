import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bulkEditNote } from '../../../src/vault/editor.js';

// ---------------------------------------------------------------------------
// bulkEditNote — atomic multi-edit. Separate module-scope vault because the
// tests mint and tear down their own tmpdir per case.
// ---------------------------------------------------------------------------

describe('bulkEditNote', () => {
  let bulkVault: string;
  const bulkRel = 'bulk.md';

  async function seedBulk(content: string): Promise<void> {
    bulkVault = await mkdtemp(join(tmpdir(), 'kg-bulk-'));
    await writeFile(join(bulkVault, bulkRel), content, 'utf-8');
  }

  const readBulk = () => readFile(join(bulkVault, bulkRel), 'utf-8');

  afterEach(async () => {
    if (bulkVault) await rm(bulkVault, { recursive: true, force: true });
  });

  it('happy path: applies 2 edits in sequence, final content reflects both', async () => {
    await seedBulk('# Title\n\nFirst paragraph.\n');
    const result = await bulkEditNote(bulkVault, bulkRel, [
      { kind: 'append', content: '\nSecond paragraph.\n' },
      { kind: 'replace_window', search: 'First paragraph.', content: 'Updated first paragraph.' },
    ]);
    expect(result.editsApplied).toBe(2);
    expect(result.bytesWritten).toBeGreaterThan(0);
    const disk = await readBulk();
    expect(disk).toContain('Updated first paragraph.');
    expect(disk).toContain('Second paragraph.');
  });

  it('atomic rollback: second edit fails → file unchanged on disk, error names edits[1]', async () => {
    const initial = '# Title\n\nSome content here.\n';
    await seedBulk(initial);
    await expect(
      bulkEditNote(bulkVault, bulkRel, [
        { kind: 'append', content: '\nAppended.\n' },
        { kind: 'replace_window', search: 'DOES_NOT_EXIST', content: 'replacement' },
      ]),
    ).rejects.toThrow(/edits\[1\]/);
    expect(await readBulk()).toBe(initial);
  });

  it('empty array → editsApplied: 0, bytesWritten: 0, no disk write', async () => {
    const initial = 'unchanged content\n';
    await seedBulk(initial);
    const result = await bulkEditNote(bulkVault, bulkRel, []);
    expect(result.editsApplied).toBe(0);
    expect(result.bytesWritten).toBe(0);
    expect(await readBulk()).toBe(initial);
  });

  it('no-op edits (same content) → bytesWritten: 0, no disk write', async () => {
    const initial = 'stable\n';
    await seedBulk(initial);
    const result = await bulkEditNote(bulkVault, bulkRel, []);
    expect(result.bytesWritten).toBe(0);
    expect(result.before).toBe(result.after);
  });
});
