import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, existsSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { VaultWriter } from '../../src/vault/writer.js';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { getNode } from '../../src/store/nodes.js';
import { getEdgesBySource } from '../../src/store/edges.js';

const FIXTURE_VAULT = join(import.meta.dirname, '..', 'fixtures', 'vault');

describe('VaultWriter', () => {
  let tempVault: string;
  let db: DatabaseHandle;
  let writer: VaultWriter;

  beforeEach(() => {
    tempVault = mkdtempSync(join(tmpdir(), 'kg-writer-'));
    cpSync(FIXTURE_VAULT, tempVault, { recursive: true });
    db = openDb(':memory:');
    writer = new VaultWriter(tempVault, db);
  });

  afterEach(() => {
    db.close();
  });

  describe('createNode', () => {
    it('creates a new markdown file with frontmatter', () => {
      writer.createNode({
        title: 'New Concept',
        directory: 'Concepts',
        frontmatter: { type: 'concept', tags: ['test'] },
        content: 'This is a new concept about testing.',
      });

      const filePath = join(tempVault, 'Concepts', 'New Concept.md');
      expect(existsSync(filePath)).toBe(true);

      const raw = readFileSync(filePath, 'utf-8');
      expect(raw).toContain('title: New Concept');
      expect(raw).toContain('type: concept');
      expect(raw).toContain('This is a new concept about testing.');
    });

    it('indexes the new node in the store', () => {
      writer.createNode({
        title: 'New Concept',
        directory: 'Concepts',
        frontmatter: { type: 'concept' },
        content: 'A test concept.',
      });

      const node = getNode(db, 'Concepts/New Concept.md');
      expect(node).toBeDefined();
      expect(node!.title).toBe('New Concept');
    });

    it('creates directories that do not exist', () => {
      writer.createNode({
        title: 'Fresh Note',
        directory: 'NewDir',
        frontmatter: {},
        content: 'In a new directory.',
      });

      const filePath = join(tempVault, 'NewDir', 'Fresh Note.md');
      expect(existsSync(filePath)).toBe(true);
    });

    it('creates at vault root when no directory specified', () => {
      writer.createNode({
        title: 'Root Note',
        frontmatter: {},
        content: 'At the root.',
      });

      const filePath = join(tempVault, 'Root Note.md');
      expect(existsSync(filePath)).toBe(true);
    });

    it('throws if the file already exists', () => {
      expect(() =>
        writer.createNode({
          title: 'Alice Smith',
          directory: 'People',
          frontmatter: {},
          content: 'Duplicate.',
        }),
      ).toThrow(/already exists/);
    });
  });

  describe('annotateNode', () => {
    it('appends content to an existing file', () => {
      writer.annotateNode(
        'People/Alice Smith.md',
        '\n## Agent Notes\nAlice is a key connector.',
      );

      const raw = readFileSync(
        join(tempVault, 'People', 'Alice Smith.md'),
        'utf-8',
      );
      expect(raw).toContain('## Agent Notes');
      expect(raw).toContain('Alice is a key connector.');
    });

    it('re-indexes the node in the store after annotation', () => {
      writer.createNode({
        title: 'Temp Note',
        frontmatter: {},
        content: 'Original content.',
      });
      const before = getNode(db, 'Temp Note.md');
      expect(before!.content).toContain('Original content.');

      writer.annotateNode('Temp Note.md', '\n\nAppended content.');
      const after = getNode(db, 'Temp Note.md');
      expect(after!.content).toContain('Appended content.');
    });

    it('throws if the node does not exist', () => {
      expect(() => writer.annotateNode('nonexistent.md', 'stuff')).toThrow(
        /not found/,
      );
    });
  });

  describe('addLink', () => {
    it('appends a wiki link to the source file', () => {
      writer.createNode({
        title: 'Source',
        frontmatter: {},
        content: 'Some content.',
      });

      writer.addLink('Source.md', 'People/Alice Smith', 'Related to Alice.');

      const raw = readFileSync(join(tempVault, 'Source.md'), 'utf-8');
      expect(raw).toContain('[[People/Alice Smith]]');
      expect(raw).toContain('Related to Alice.');
    });

    it('creates an edge in the store', () => {
      writer.createNode({
        title: 'Source',
        frontmatter: {},
        content: 'Some content.',
      });

      writer.addLink('Source.md', 'People/Alice Smith', 'Related to Alice.');

      const edges = getEdgesBySource(db, 'Source.md');
      expect(edges.some((e) => e.targetId === 'People/Alice Smith.md')).toBe(
        true,
      );
    });
  });

  describe('createNode title-injection opt-out (F11)', () => {
    it('auto-injects title when caller omits it', () => {
      writer.createNode({
        title: 'AutoTitleTest',
        frontmatter: { tags: ['a'] },
        content: 'body',
      });
      const raw = readFileSync(join(tempVault, 'AutoTitleTest.md'), 'utf-8');
      expect(raw).toContain('title: AutoTitleTest');
    });

    it('respects explicit frontmatter.title: null as opt-out', () => {
      writer.createNode({
        title: 'NoTitle',
        frontmatter: { title: null, tags: ['a'] },
        content: 'body',
      });
      const raw = readFileSync(join(tempVault, 'NoTitle.md'), 'utf-8');
      expect(raw).not.toContain('title:');
      expect(raw).toContain('tags:');
    });

    it('keeps a custom title when caller sets their own', () => {
      writer.createNode({
        title: 'Filename',
        frontmatter: { title: 'Human Readable Title' },
        content: 'body',
      });
      const raw = readFileSync(join(tempVault, 'Filename.md'), 'utf-8');
      expect(raw).toContain('title: Human Readable Title');
    });
  });
});
