/**
 * Unit tests for `obsidian-brain health` (src/cli/health.ts).
 *
 * Strategy mirrors test/cli/models.test.ts: register the command on a fresh
 * Commander program and drive it with `parseAsync`, capturing stdout/stderr
 * by swapping `process.stdout.write` / `process.stderr.write`. The command
 * sets `process.exitCode` (never calls `process.exit`), so tests read and
 * reset it. `createContext` is mocked to hand back an in-memory DB + a temp
 * vault, so no env vars or embedder are involved.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { upsertNode } from '../../src/store/nodes.js';
import { insertEdge } from '../../src/store/edges.js';
import { setSyncMtime } from '../../src/store/sync.js';
import { UserError } from '../../src/errors.js';

const { mockCreateContext } = vi.hoisted(() => ({ mockCreateContext: vi.fn() }));
vi.mock('../../src/context.js', () => ({ createContext: mockCreateContext }));

import {
  registerHealthCommand,
  runHealthCommand,
  parseHealthOptions,
  EXIT_OK,
  EXIT_FINDINGS,
  EXIT_USAGE,
  EXIT_INTERNAL,
} from '../../src/cli/health.js';

const BODY = 'A body long enough to clear the empty-note threshold without any trouble.';

interface Captured {
  stdout: string;
  stderr: string;
  exitCode: number | undefined;
}

async function runHealth(args: string[]): Promise<Captured> {
  const program = new Command();
  program.name('obsidian-brain').exitOverride().configureOutput({ writeErr: () => {} });
  registerHealthCommand(program);

  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (c) => (out.push(String(c)), true);
  (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (c) => (err.push(String(c)), true);
  process.exitCode = undefined;
  try {
    await program.parseAsync(['node', 'cli', 'health', ...args]);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  const exitCode = process.exitCode as number | undefined;
  process.exitCode = undefined;
  return { stdout: out.join(''), stderr: err.join(''), exitCode };
}

function addNote(db: DatabaseHandle, vault: string, id: string, content: string, onDisk = true): void {
  upsertNode(db, { id, title: id.replace(/\.md$/, ''), content, frontmatter: { a: 1 } });
  if (onDisk) {
    const abs = join(vault, id);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    setSyncMtime(db, id, statSync(abs).mtimeMs);
  } else {
    setSyncMtime(db, id, 1);
  }
}

describe('obsidian-brain health', () => {
  let db: DatabaseHandle;
  let vault: string;

  beforeEach(() => {
    db = openDb(':memory:');
    vault = mkdtempSync(join(tmpdir(), 'cli-health-'));
    addNote(db, vault, 'A.md', `${BODY} [[B]]`);
    addNote(db, vault, 'Sub/B.md', `${BODY} [[A]] [[Missing]]`);
    insertEdge(db, { sourceId: 'A.md', targetId: 'Sub/B.md', context: '' });
    insertEdge(db, { sourceId: 'Sub/B.md', targetId: 'A.md', context: '' });
    upsertNode(db, { id: '_stub/Missing.md', title: 'Missing', content: '', frontmatter: { _stub: true } });
    insertEdge(db, { sourceId: 'Sub/B.md', targetId: '_stub/Missing.md', context: '' });
    mockCreateContext.mockReset();
    mockCreateContext.mockImplementation(async () => ({ db, config: { vaultPath: vault } }));
  });

  afterEach(() => {
    if (db.open) db.close();
    rmSync(vault, { recursive: true, force: true });
  });

  it('prints the report as JSON, exits 0 with only warn findings, and closes the DB', async () => {
    const r = await runHealth([]);
    const report = JSON.parse(r.stdout);
    expect(report.checksRun).toHaveLength(7);
    expect(report.counts.broken_links).toBe(1);
    expect(report.bySeverity.error).toBe(0);
    expect(r.exitCode).toBe(EXIT_OK);
    expect(r.stderr).toBe('');
    expect(db.open).toBe(false);
  });

  it('exits 1 when any error-severity finding exists', async () => {
    addNote(db, vault, 'Gone.md', BODY, false);
    const r = await runHealth(['--checks', 'index_drift']);
    const report = JSON.parse(r.stdout);
    expect(report.findings.index_drift.items[0]).toMatchObject({ path: 'Gone.md', kind: 'missing_on_disk' });
    expect(r.exitCode).toBe(EXIT_FINDINGS);
    expect(db.open).toBe(false);
  });

  it('passes --checks / --scope / --limit / --min-body-chars through', async () => {
    const r = await runHealth([
      '--checks', ' broken_links , empty_notes,',
      '--scope', 'Sub',
      '--limit', '1',
      '--min-body-chars', '1000',
    ]);
    const report = JSON.parse(r.stdout);
    expect(report.checksRun).toEqual(['broken_links', 'empty_notes']);
    expect(report.scope).toBe('Sub');
    expect(report.findings.empty_notes.count).toBe(1);
    expect(report.findings.empty_notes.items[0].path).toBe('Sub/B.md');
    expect(report.findings.broken_links.items).toHaveLength(1);
  });

  it.each([
    [['--checks', 'orphans,bogus'], /unknown check for --checks: bogus/],
    [['--checks', 'nope,bogus'], /unknown checks for --checks: nope, bogus/],
    [['--checks', ' , '], /--checks needs at least one check/],
    [['--limit', '0'], /--limit must be an integer ≥ 1/],
    [['--limit', 'abc'], /--limit must be an integer ≥ 1 \(got 'abc'\)/],
    [['--limit', '2.5'], /--limit must be an integer/],
    [['--min-body-chars', '-1'], /--min-body-chars must be an integer ≥ 0/],
  ])('bad arguments %j exit 2 without opening the index', async (args, message) => {
    const r = await runHealth(args);
    expect(r.exitCode).toBe(EXIT_USAGE);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(message);
    expect(mockCreateContext).not.toHaveBeenCalled();
  });

  it('a configuration UserError (e.g. no VAULT_PATH) exits 2 with the friendly message', async () => {
    mockCreateContext.mockRejectedValueOnce(new UserError('VAULT_PATH is not set', { hint: 'set it' }));
    const r = await runHealth([]);
    expect(r.exitCode).toBe(EXIT_USAGE);
    expect(r.stderr).toContain('obsidian-brain: VAULT_PATH is not set');
    expect(r.stderr).toContain('set it');
  });

  it('an unexpected context failure exits 3 with the error on stderr', async () => {
    mockCreateContext.mockRejectedValueOnce(new Error('disk on fire'));
    const r = await runHealth([]);
    expect(r.exitCode).toBe(EXIT_INTERNAL);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^CLI error: Error: disk on fire/);
  });

  it('a non-Error throw is still reported and exits 3', async () => {
    mockCreateContext.mockRejectedValueOnce('plain string');
    const r = await runHealth([]);
    expect(r.exitCode).toBe(EXIT_INTERNAL);
    expect(r.stderr).toBe('CLI error: plain string\n');
  });

  it('a failure while computing the report exits 3, prints no JSON, and still closes the DB', async () => {
    const broken = openDb(':memory:');
    broken.exec('DROP TABLE sync');
    mockCreateContext.mockImplementationOnce(async () => ({ db: broken, config: { vaultPath: vault } }));
    const r = await runHealth(['--checks', 'index_drift']);
    expect(r.exitCode).toBe(EXIT_INTERNAL);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/CLI error: .*no such table: sync/);
    expect(broken.open).toBe(false);
  });

  it('an Error without a stack falls back to its message', async () => {
    const err = new Error('no stack here');
    err.stack = undefined;
    mockCreateContext.mockRejectedValueOnce(err);
    const r = await runHealth([]);
    expect(r.exitCode).toBe(EXIT_INTERNAL);
    expect(r.stderr).toBe('CLI error: no stack here\n');
  });

  it('warns on stderr when the index is empty (still prints JSON)', async () => {
    const empty = openDb(':memory:');
    const code = await (async () => {
      const err: string[] = [];
      const out: string[] = [];
      const origOut = process.stdout.write.bind(process.stdout);
      const origErr = process.stderr.write.bind(process.stderr);
      (process.stdout as unknown as { write: (c: unknown) => boolean }).write = (c) => (out.push(String(c)), true);
      (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (c) => (err.push(String(c)), true);
      try {
        const c = await runHealthCommand({}, async () => ({ db: empty, config: { vaultPath: vault } as never }));
        expect(err.join('')).toContain("run 'obsidian-brain index' first");
        expect(JSON.parse(out.join('')).notesScanned).toBe(0);
        return c;
      } finally {
        process.stdout.write = origOut;
        process.stderr.write = origErr;
      }
    })();
    expect(code).toBe(EXIT_OK);
    expect(empty.open).toBe(false);
  });
});

describe('parseHealthOptions', () => {
  it('returns an empty options object when no flags are given', () => {
    expect(parseHealthOptions({})).toEqual({});
  });

  it('parses every flag', () => {
    expect(
      parseHealthOptions({ checks: 'orphans', scope: 'X', limit: '5', minBodyChars: '0' }),
    ).toEqual({ checks: ['orphans'], scope: 'X', limit: 5, minBodyChars: 0 });
  });
});
