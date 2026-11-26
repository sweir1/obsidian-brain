/**
 * resolveForwardStubs uses the parser's own resolveLink, so stubs migrate
 * under the same rules that resolve links — including the case-insensitive
 * fallback (`_stub/note.md` → `Note.md`) and path-qualified stubs.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { getNode, upsertNode } from '../../src/store/nodes.js';
import { getEdgesBySource, insertEdge } from '../../src/store/edges.js';
import { materialiseStubs, migrateStubsForNote, resolveForwardStubs } from '../../src/pipeline/indexer/stubs.js';

let db: DatabaseHandle;

function note(id: string): void {
  upsertNode(db, { id, title: id, content: '', frontmatter: {} });
}

function linkToStub(from: string, stubId: string): void {
  materialiseStubs(db, new Set([stubId]));
  insertEdge(db, { sourceId: from, targetId: stubId, context: 'ctx', targetSubpath: null });
}

beforeEach(() => {
  db = openDb(':memory:');
  note('src.md');
});

afterEach(() => {
  db.close();
});

describe('resolveForwardStubs', () => {
  it('migrates an exact-case stub', () => {
    linkToStub('src.md', '_stub/Future.md');
    note('Future.md');
    expect(resolveForwardStubs(db)).toBe(1);
    expect(getNode(db, '_stub/Future.md')).toBeUndefined();
    expect(getEdgesBySource(db, 'src.md').map((e) => e.targetId)).toEqual(['Future.md']);
  });

  it('migrates a lower-case stub to a top-level note with different casing', () => {
    linkToStub('src.md', '_stub/note.md');
    note('Note.md');
    resolveForwardStubs(db);
    expect(getNode(db, '_stub/note.md')).toBeUndefined();
    expect(getEdgesBySource(db, 'src.md').map((e) => e.targetId)).toEqual(['Note.md']);
  });

  it('migrates a path-qualified stub, case-insensitively', () => {
    linkToStub('src.md', '_stub/folder/note.md');
    note('Folder/Note.md');
    resolveForwardStubs(db);
    expect(getEdgesBySource(db, 'src.md').map((e) => e.targetId)).toEqual(['Folder/Note.md']);
  });

  it('leaves unresolvable, legacy fragment and legacy same-note stubs alone', () => {
    linkToStub('src.md', '_stub/Missing.md');
    linkToStub('src.md', '_stub/BMW#Specs.md');
    linkToStub('src.md', '_stub/.md');
    note('BMW.md');
    expect(resolveForwardStubs(db)).toBe(0);
    expect(getNode(db, '_stub/Missing.md')).toBeDefined();
    expect(getNode(db, '_stub/BMW#Specs.md')).toBeDefined();
    expect(getNode(db, '_stub/.md')).toBeDefined();
  });

  it('onlyStem restricts the pass to matching stubs (case-insensitive)', () => {
    linkToStub('src.md', '_stub/alpha.md');
    linkToStub('src.md', '_stub/beta.md');
    note('Alpha.md');
    note('Beta.md');
    expect(resolveForwardStubs(db, 'ALPHA')).toBe(1);
    expect(getNode(db, '_stub/alpha.md')).toBeUndefined();
    expect(getNode(db, '_stub/beta.md')).toBeDefined();
    expect(resolveForwardStubs(db, 'gamma')).toBe(0);
  });

  it('is a no-op when there are no stubs', () => {
    note('Lonely.md');
    expect(resolveForwardStubs(db)).toBe(0);
  });
});

describe('migrateStubsForNote', () => {
  it('treats the new path as real even before its node row exists', () => {
    linkToStub('src.md', '_stub/later.md');
    expect(migrateStubsForNote(db, 'Sub/Later.md')).toBe(1);
    expect(getEdgesBySource(db, 'src.md').map((e) => e.targetId)).toEqual(['Sub/Later.md']);
  });

  it('ignores stubs for other stems and returns 0 for an empty stem', () => {
    linkToStub('src.md', '_stub/other.md');
    expect(migrateStubsForNote(db, 'Later.md')).toBe(0);
    expect(migrateStubsForNote(db, '.md')).toBe(0);
    expect(getNode(db, '_stub/other.md')).toBeDefined();
  });
});
