import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDb, type DatabaseHandle } from '../../src/store/db.js';
import { bootstrap } from '../../src/pipeline/bootstrap.js';
import { upsertNode } from '../../src/store/nodes.js';
import { getMetadata } from '../../src/store/metadata.js';
import { upsertEmbedding } from '../../src/store/embeddings.js';
import { getEdgesBySource } from '../../src/store/edges.js';
import type { Embedder } from '../../src/embeddings/types.js';

/**
 * Minimal stub embedder for tests. Never calls out to the real model —
 * bootstrap only reads identity + dim, never actually embeds.
 */
class StubEmbedder implements Embedder {
  constructor(
    private readonly _model: string,
    private readonly _dim: number,
    private readonly _provider: string = 'stub',
  ) {}
  async init(): Promise<void> { /* no-op */ }
  async embed(): Promise<Float32Array> { return new Float32Array(this._dim); }
  dimensions(): number { return this._dim; }
  modelIdentifier(): string { return this._model; }
  providerName(): string { return this._provider; }
  async dispose(): Promise<void> { /* no-op */ }
}

function mkEmb(dim: number, seed = 0): Float32Array {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.sin(i + seed) * 0.5;
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm);
  for (let i = 0; i < dim; i++) v[i] /= norm;
  return v;
}

describe('bootstrap', () => {
  let db: DatabaseHandle;

  beforeEach(() => {
    db = openDb(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('stamps metadata on first boot without requesting reindex', () => {
    const emb = new StubEmbedder('Xenova/all-MiniLM-L6-v2', 384);
    const result = bootstrap(db, emb);
    expect(result.needsReindex).toBe(false);
    expect(getMetadata(db, 'embedding_model')).toBe('Xenova/all-MiniLM-L6-v2');
    expect(getMetadata(db, 'embedding_dim')).toBe('384');
    expect(getMetadata(db, 'schema_version')).toBeDefined();
    expect(getMetadata(db, 'embedder_provider')).toBe('stub');
  });

  it('is idempotent when the embedder identity has not changed', () => {
    const emb = new StubEmbedder('Xenova/all-MiniLM-L6-v2', 384);
    bootstrap(db, emb);
    const second = bootstrap(db, emb);
    expect(second.needsReindex).toBe(false);
    expect(second.reasons).toEqual([]);
  });

  it('requests reindex and wipes state when the model identifier changes', () => {
    const oldEmb = new StubEmbedder('Xenova/all-MiniLM-L6-v2', 384);
    bootstrap(db, oldEmb);

    // Simulate some existing embedded state.
    upsertNode(db, { id: 'n.md', title: 'n', content: 'body', frontmatter: {} });
    upsertEmbedding(db, 'n.md', mkEmb(384));
    db.prepare(
      'INSERT INTO sync (path, mtime, indexed_at) VALUES (?, ?, ?)',
    ).run('n.md', 1000, 2000);

    const newEmb = new StubEmbedder('Xenova/bge-small-en-v1.5', 384);
    const result = bootstrap(db, newEmb);
    expect(result.needsReindex).toBe(true);
    expect(result.reasons.some((r) => r.includes('embedder changed'))).toBe(true);

    // Embedding + sync state should have been dropped.
    const syncCount = (db.prepare('SELECT COUNT(*) AS n FROM sync').get() as { n: number }).n;
    expect(syncCount).toBe(0);
    expect(getMetadata(db, 'embedding_model')).toBe('Xenova/bge-small-en-v1.5');
  });

  it('requests reindex when dim changes, even if model name is the same', () => {
    const a = new StubEmbedder('custom-model', 384);
    bootstrap(db, a);
    const b = new StubEmbedder('custom-model', 768);
    const result = bootstrap(db, b);
    expect(result.needsReindex).toBe(true);
    expect(getMetadata(db, 'embedding_dim')).toBe('768');
  });

  it('v1.3.1 upgrade path: nodes exist but chunks table is empty → reindex', () => {
    const emb = new StubEmbedder('Xenova/all-MiniLM-L6-v2', 384);
    // Simulate a pre-1.4 install: nodes exist, embedder metadata matches,
    // chunks table is empty. bootstrap should flag a reindex anyway.
    bootstrap(db, emb); // first-boot stamp (no nodes yet)
    upsertNode(db, { id: 'legacy.md', title: 'legacy', content: 'body', frontmatter: {} });
    const second = bootstrap(db, emb);
    expect(second.needsReindex).toBe(true);
    expect(second.reasons.some((r) => r.includes('chunk table is empty'))).toBe(true);
  });

  it('records provider name in metadata', () => {
    const emb = new StubEmbedder('custom-model', 256);
    bootstrap(db, emb);
    expect(getMetadata(db, 'embedder_provider')).toBe('stub');
  });

  it('rebuilds the FTS index when the tokenizer changed', () => {
    // Simulate a pre-1.4.0 DB: drop the new FTS and replace with an
    // older schema (no `tokenize` clause).
    db.exec('DROP TABLE nodes_fts');
    db.exec(
      "CREATE VIRTUAL TABLE nodes_fts USING fts5(title, content, content='nodes', content_rowid='rowid')",
    );
    upsertNode(db, { id: 'a.md', title: 'Alpha', content: 'body running', frontmatter: {} });

    const emb = new StubEmbedder('Xenova/all-MiniLM-L6-v2', 384);
    const result = bootstrap(db, emb);
    expect(result.reasons.some((r) => r.includes('FTS tokenizer changed'))).toBe(true);

    const sql = (
      db.prepare("SELECT sql FROM sqlite_master WHERE name = 'nodes_fts'").get() as { sql: string }
    ).sql;
    expect(sql).toContain('porter unicode61');
  });

  // ── v1.5.1 prefix-strategy migration tests ────────────────────────────────

  it('schema_version bump triggers needsReindex with a schema-version reason', () => {
    // Simulate an existing DB with schema_version = 2 (pre-v1.5.1).
    // We need to first boot with schema version 2 stored, then call bootstrap
    // again after the code has SCHEMA_VERSION = 3.
    const emb = new StubEmbedder('Xenova/all-MiniLM-L6-v2', 384, 'transformers.js');
    // First boot: stamps current SCHEMA_VERSION (3) with no nodes → no reindex.
    bootstrap(db, emb);
    // Manually downgrade the stored schema_version to simulate upgrading from v1.5.0 → v1.5.1.
    db.prepare("UPDATE index_metadata SET value = '2' WHERE key = 'schema_version'").run();
    // Wipe the prefix strategy too so it doesn't interfere.
    db.prepare("DELETE FROM index_metadata WHERE key = 'embedder_prefix_strategy'").run();

    const result = bootstrap(db, emb);
    expect(result.needsReindex).toBe(true);
    expect(result.reasons.some((r) => r.includes('schema version changed'))).toBe(true);
  });

  it('MiniLM → MiniLM: symmetric model upgrade path causes no prefix-strategy reindex', () => {
    // First boot: MiniLM (symmetric) — stamps prefix strategy as ''.
    const emb = new StubEmbedder('Xenova/all-MiniLM-L6-v2', 384, 'transformers.js');
    bootstrap(db, emb);
    // Second boot: same embedder — stored strategy is '' and current is '' → no reindex.
    const result = bootstrap(db, emb);
    expect(result.needsReindex).toBe(false);
    expect(result.reasons.every((r) => !r.includes('prefix strategy'))).toBe(true);
  });

  it('bge-small first v1.5.1 boot: no stored prefix strategy → reindex with "first v1.5.1 boot" reason', () => {
    // Simulate a pre-v1.5.1 BGE user: has model+dim stored but no prefix strategy key.
    const emb = new StubEmbedder('Xenova/bge-small-en-v1.5', 384, 'transformers.js');
    bootstrap(db, emb); // stamps prefix strategy
    // Wipe the prefix strategy to simulate upgrading from v1.5.0 (which never wrote it).
    db.prepare("DELETE FROM index_metadata WHERE key = 'embedder_prefix_strategy'").run();

    const result = bootstrap(db, emb);
    expect(result.needsReindex).toBe(true);
    expect(result.reasons.some((r) => r.includes('first v1.5.1 boot'))).toBe(true);
  });

  it('bge-small → MiniLM model switch: model-change path fires (needsReindex regardless of prefix check)', () => {
    // Boot 1: BGE (asymmetric).
    const bgeEmb = new StubEmbedder('Xenova/bge-small-en-v1.5', 384, 'transformers.js');
    bootstrap(db, bgeEmb);

    // Boot 2: switch to MiniLM (symmetric, same dim). Model mismatch fires first.
    const miniLMEmb = new StubEmbedder('Xenova/all-MiniLM-L6-v2', 384, 'transformers.js');
    const result = bootstrap(db, miniLMEmb);
    expect(result.needsReindex).toBe(true);
    expect(result.reasons.some((r) => r.includes('embedder changed'))).toBe(true);
  });

  // ── Schema migration chain regression (v1.6.9 + v1.6.11) ──────────────────

  it('pre-v4 DB: bootstrap chain adds target_subpath and leaves queries working', () => {
    // Simulate a pre-v1.6.5 DB: the physical `edges` table has neither
    // target_fragment nor target_subpath, and schema_version is v3. The
    // chain has to apply the v4 migration (add target_fragment) and then
    // the v5 migration (rename to target_subpath).
    const emb = new StubEmbedder('Xenova/all-MiniLM-L6-v2', 384, 'transformers.js');
    bootstrap(db, emb); // first boot stamps current SCHEMA_VERSION
    db.exec('ALTER TABLE edges DROP COLUMN target_subpath');
    db.prepare("UPDATE index_metadata SET value = '3' WHERE key = 'schema_version'").run();
    upsertNode(db, { id: 'a.md', title: 'A', content: 'x', frontmatter: {} });
    upsertNode(db, { id: 'b.md', title: 'B', content: 'x', frontmatter: {} });
    db.prepare(
      "INSERT INTO edges (source_id, target_id, context) VALUES ('a.md', 'b.md', 'link')",
    ).run();

    const result = bootstrap(db, emb);

    expect(result.reasons.some((r) => r.includes('schema version changed'))).toBe(true);
    const cols = db
      .prepare("PRAGMA table_info('edges')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('target_subpath'); // v5 end state
    expect(names).not.toContain('target_fragment'); // v4 intermediate renamed away
    // And the prod query path now works.
    expect(() => getEdgesBySource(db, 'a.md')).not.toThrow();
    const edges = getEdgesBySource(db, 'a.md');
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ sourceId: 'a.md', targetId: 'b.md', targetSubpath: null });
  });

  it('v4 → v5: bootstrap renames target_fragment to target_subpath in place', () => {
    // User on v1.6.5–v1.6.10: has target_fragment, schema_version=4. v1.6.11
    // should run the rename migration and leave target_subpath in place.
    const emb = new StubEmbedder('Xenova/all-MiniLM-L6-v2', 384, 'transformers.js');
    bootstrap(db, emb);
    // Simulate a v4 DB: rename target_subpath back to target_fragment to
    // reverse our own migration for the test's pre-state.
    db.exec('ALTER TABLE edges RENAME COLUMN target_subpath TO target_fragment');
    db.prepare("UPDATE index_metadata SET value = '4' WHERE key = 'schema_version'").run();
    db.prepare(
      "INSERT INTO edges (source_id, target_id, context, target_fragment) VALUES ('x.md', 'y.md', 'link', 'Heading')",
    ).run();

    bootstrap(db, emb);

    const cols = db
      .prepare("PRAGMA table_info('edges')")
      .all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toContain('target_subpath');
    expect(names).not.toContain('target_fragment');
    // Data survives the rename.
    const row = db
      .prepare('SELECT target_subpath FROM edges WHERE source_id = ? AND target_id = ?')
      .get('x.md', 'y.md') as { target_subpath: string | null };
    expect(row.target_subpath).toBe('Heading');
  });

  it('belt-and-braces: bootstrap chain heals even when schema_version is already current', () => {
    // Pre-v1.6.9 bug class: schema_version got stamped ahead of the actual
    // schema. Both v4 and v5 chain entries must run unconditionally to heal
    // a DB where the ALTER was skipped.
    const emb = new StubEmbedder('Xenova/all-MiniLM-L6-v2', 384, 'transformers.js');
    bootstrap(db, emb); // schema_version = current, target_subpath present
    db.exec('ALTER TABLE edges DROP COLUMN target_subpath');
    // Leave schema_version at current — the chain's conditional loop does
    // NOT fire, but the unconditional belt-and-braces pass must restore it.

    bootstrap(db, emb);

    const cols = db
      .prepare("PRAGMA table_info('edges')")
      .all() as Array<{ name: string }>;
    expect(cols.map((c) => c.name)).toContain('target_subpath');
  });

  it('PREFIX_STRATEGY_VERSION bump: v1 prefix-strategy DB triggers needsReindex', () => {
    // Simulate a user who was on PREFIX_STRATEGY_VERSION=1 with an asymmetric model
    // (e.g. BGE). First boot stamps the prefix strategy hash. We then manually
    // overwrite the stored strategy with a hash computed under v1 (any non-empty
    // string that differs from the current hash) to trigger the reindex path.
    const emb = new StubEmbedder('Xenova/bge-small-en-v1.5', 384, 'transformers.js');
    bootstrap(db, emb); // stamps correct current strategy
    // Overwrite with a stale v1-era hash (simulated by writing any different non-empty value).
    db.prepare(
      "UPDATE index_metadata SET value = 'stale_v1_hash_abcdef01' WHERE key = 'embedder_prefix_strategy'",
    ).run();

    const result = bootstrap(db, emb);
    expect(result.needsReindex).toBe(true);
    expect(result.reasons.some((r) => r.includes('prefix strategy changed'))).toBe(true);
  });

  it('Ollama provider: computePrefixStrategy returns empty → no prefix-strategy reindex', () => {
    // Ollama with an asymmetric model name still returns '' from computePrefixStrategy
    // because provider !== 'transformers.js'.
    const emb = new StubEmbedder('bge-small-en-v1.5', 384, 'ollama');
    bootstrap(db, emb);
    const result = bootstrap(db, emb);
    expect(result.needsReindex).toBe(false);
    // No prefix-strategy reason should appear.
    expect(result.reasons.every((r) => !r.includes('prefix strategy'))).toBe(true);
  });
});
