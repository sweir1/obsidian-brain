import { describe, it, expect } from 'vitest';
import {
  computeSearchHints,
  computeReadNoteHints,
  computeFindConnectionsHints,
  isContextualResult,
} from '../../src/tools/hints.js';

describe('hints/computeSearchHints', () => {
  it('suggests a simplified query on zero hits', () => {
    const ctx = computeSearchHints('the philosophy of mind and consciousness', []);
    expect(ctx.state?.last_search_query).toBe(
      'the philosophy of mind and consciousness',
    );
    expect(ctx.state?.last_search_results).toEqual([]);
    expect(ctx.next_actions).toBeDefined();
    expect(ctx.next_actions!.length).toBeGreaterThan(0);
    const retry = ctx.next_actions![0]!;
    expect(retry.tool).toBe('search');
    const retryQuery = retry.args.query as string;
    expect(retryQuery.length).toBeLessThan(
      'the philosophy of mind and consciousness'.length,
    );
    expect(retry.reason).toMatch(/broader phrasing/i);
  });

  it('does not emit a retry action when the query is already trivial', () => {
    const ctx = computeSearchHints('auth', []);
    expect(ctx.next_actions).toEqual([]);
  });

  it('points at read_note + find_connections when there are multiple hits', () => {
    const ctx = computeSearchHints('auth flow', [
      { nodeId: 'notes/auth.md', title: 'Auth', score: 0.91 },
      { nodeId: 'notes/login.md', title: 'Login', score: 0.73 },
      { nodeId: 'notes/oauth.md', title: 'OAuth', score: 0.65 },
    ]);
    expect(ctx.state?.last_search_query).toBe('auth flow');
    expect(ctx.state?.last_search_results).toEqual([
      'notes/auth.md',
      'notes/login.md',
      'notes/oauth.md',
    ]);
    expect(ctx.next_actions!.map((a) => a.tool)).toEqual([
      'read_note',
      'find_connections',
    ]);
    expect(ctx.next_actions![0]!.args).toEqual({ name: 'notes/auth.md' });
    expect(ctx.next_actions![0]!.reason).toContain('0.910');
    expect(ctx.next_actions![1]!.args).toEqual({
      name: 'notes/auth.md',
      depth: 2,
    });
  });

  it('only emits read_note (not find_connections) for a single hit', () => {
    const ctx = computeSearchHints('unique', [
      { nodeId: 'notes/unique.md', title: 'Unique', score: 0.5 },
    ]);
    expect(ctx.next_actions!.map((a) => a.tool)).toEqual(['read_note']);
  });
});

describe('hints/computeReadNoteHints', () => {
  it('suggests create_note when there are unresolved wiki-links', () => {
    const ctx = computeReadNoteHints({
      id: 'notes/a.md',
      outgoing: ['notes/b.md'],
      unresolvedLinks: ['Phantom Note', 'Missing Other'],
    });
    const create = ctx.next_actions!.find((a) => a.tool === 'create_note');
    expect(create).toBeDefined();
    expect(create!.args).toEqual({ title: 'Phantom Note' });
    expect(create!.reason).toContain('2 unresolved');
    expect(ctx.state?.last_file_unresolved_links).toEqual([
      'Phantom Note',
      'Missing Other',
    ]);
  });

  it('suggests find_connections when there are outgoing links', () => {
    const ctx = computeReadNoteHints({
      id: 'notes/a.md',
      outgoing: ['notes/b.md', 'notes/c.md'],
      unresolvedLinks: [],
    });
    const explore = ctx.next_actions!.find((a) => a.tool === 'find_connections');
    expect(explore).toBeDefined();
    expect(explore!.args).toEqual({ name: 'notes/a.md' });
    expect(ctx.state?.last_file_outgoing).toEqual(['notes/b.md', 'notes/c.md']);
  });

  it('emits no actions for a fully-resolved leaf note', () => {
    const ctx = computeReadNoteHints({
      id: 'notes/leaf.md',
      outgoing: [],
      unresolvedLinks: [],
    });
    expect(ctx.next_actions).toEqual([]);
    expect(ctx.state?.last_file_read).toBe('notes/leaf.md');
  });
});

describe('hints/computeFindConnectionsHints', () => {
  it('suggests detect_themes when neighbourhood is dense', () => {
    const neighbors = Array.from({ length: 15 }, (_, i) => ({
      id: `notes/n${i}.md`,
      title: `N${i}`,
    }));
    const ctx = computeFindConnectionsHints('notes/root.md', neighbors);
    const themes = ctx.next_actions!.find((a) => a.tool === 'detect_themes');
    expect(themes).toBeDefined();
    expect(themes!.reason).toContain('15 connections');
    expect(ctx.state?.last_connections_count).toBe(15);
  });

  it('suggests find_path_between using the furthest neighbour', () => {
    const ctx = computeFindConnectionsHints('notes/root.md', [
      { id: 'notes/a.md', title: 'A' },
      { id: 'notes/b.md', title: 'B' },
      { id: 'notes/far.md', title: 'Far' },
    ]);
    const path = ctx.next_actions!.find((a) => a.tool === 'find_path_between');
    expect(path).toBeDefined();
    expect(path!.args).toEqual({
      source: 'notes/root.md',
      target: 'notes/far.md',
    });
  });

  it('emits no actions on an empty neighbourhood', () => {
    const ctx = computeFindConnectionsHints('notes/isolated.md', []);
    expect(ctx.next_actions).toEqual([]);
    expect(ctx.state?.last_connections_count).toBe(0);
  });
});

describe('hints/isContextualResult', () => {
  it('recognises the {data, context} envelope shape', () => {
    expect(
      isContextualResult({ data: [], context: { next_actions: [] } }),
    ).toBe(true);
  });

  it('rejects plain objects', () => {
    expect(isContextualResult({ foo: 'bar' })).toBe(false);
    expect(isContextualResult(null)).toBe(false);
    expect(isContextualResult('string')).toBe(false);
    expect(isContextualResult({ data: 1 })).toBe(false);
    expect(isContextualResult({ context: 1 })).toBe(false);
  });

  it('envelope survives JSON round-trip cleanly', () => {
    const envelope = {
      data: { items: [1, 2, 3] },
      context: {
        state: { last_search_query: 'x' },
        next_actions: [
          {
            description: 'follow-up',
            tool: 'read_note',
            args: { name: 'a.md' },
            reason: 'because',
          },
        ],
      },
    };
    const round = JSON.parse(JSON.stringify(envelope)) as typeof envelope;
    expect(round.data).toEqual(envelope.data);
    expect(round.context.next_actions![0]!.tool).toBe('read_note');
    expect(isContextualResult(round)).toBe(true);
  });
});
