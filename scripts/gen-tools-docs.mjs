#!/usr/bin/env tsx
/**
 * scripts/gen-tools-docs.mjs
 *
 * Regenerates per-tool argument tables in docs/tools.md from Zod schemas.
 * Run under tsx so it can import TypeScript tool files directly.
 *
 * Usage:
 *   tsx scripts/gen-tools-docs.mjs          # write docs/tools.md
 *   tsx scripts/gen-tools-docs.mjs --check  # exit 1 if out of sync
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ---------------------------------------------------------------------------
// Fake server: captures registerTool calls without running handlers
// ---------------------------------------------------------------------------

const registry = new Map(); // name -> { name, schema }

/**
 * Mirrors the shape expected by registerTool's internal server.tool() call.
 * registerTool calls: (server as any).tool(name, description, schema, cb)
 */
const fakeServer = {
  tool(name, _description, schema, _handler) {
    registry.set(name, { name, schema });
  },
};

/** Minimal fake context — handlers never run */
const fakeCtx = new Proxy({}, {
  get() {
    return new Proxy(() => {}, {
      get() { return new Proxy(() => {}, { get() { return () => {}; }, apply() { return {}; } }); },
      apply() { return {}; },
    });
  },
});

// ---------------------------------------------------------------------------
// Load every tool file and call its register* function
// ---------------------------------------------------------------------------

const toolFiles = [
  'src/tools/search.ts',
  'src/tools/read-note.ts',
  'src/tools/list-notes.ts',
  'src/tools/find-connections.ts',
  'src/tools/find-path-between.ts',
  'src/tools/detect-themes.ts',
  'src/tools/rank-notes.ts',
  'src/tools/create-note.ts',
  'src/tools/edit-note.ts',
  'src/tools/apply-edit-preview.ts',
  'src/tools/link-notes.ts',
  'src/tools/move-note.ts',
  'src/tools/delete-note.ts',
  'src/tools/reindex.ts',
  'src/tools/active-note.ts',
  'src/tools/dataview-query.ts',
  'src/tools/base-query.ts',
];

for (const rel of toolFiles) {
  const absPath = resolve(ROOT, rel);
  const mod = await import(absPath);
  for (const [key, fn] of Object.entries(mod)) {
    if (typeof fn === 'function' && key.startsWith('register') && key.endsWith('Tool')) {
      fn(fakeServer, fakeCtx);
    }
  }
}

// ---------------------------------------------------------------------------
// Zod v4 schema walker
// ---------------------------------------------------------------------------

/**
 * Peel ZodDefault then ZodOptional wrappers, collecting metadata.
 * In Zod v4: _def.type is the type string (not _def.typeName).
 * Description is stored on the outermost schema instance as .description.
 */
function unwrap(zodType) {
  let optional = false;
  let hasDefault = false;
  let defaultVal = undefined;
  let cur = zodType;

  // Top-level description lives on the original (outermost) instance
  const description = zodType.description ?? '';

  // Peel ZodDefault (outer)
  while (cur._def?.type === 'default') {
    hasDefault = true;
    defaultVal = cur._def.defaultValue;
    cur = cur._def.innerType;
  }
  // Peel ZodOptional
  if (cur._def?.type === 'optional') {
    optional = true;
    cur = cur._def.innerType;
  }
  // Peel ZodDefault (inner, when optional wraps default)
  while (cur._def?.type === 'default') {
    hasDefault = true;
    defaultVal = cur._def.defaultValue;
    cur = cur._def.innerType;
  }

  return { inner: cur, optional, hasDefault, defaultVal, description };
}

/**
 * Human-readable type label for a Zod v4 inner type (after peeling wrappers).
 */
function typeLabel(inner) {
  const t = inner._def?.type ?? '';
  switch (t) {
    case 'string':  return 'string';
    case 'number':  return 'number';
    case 'boolean': return 'boolean';
    case 'literal': {
      // _def.values is an array in Zod v4
      const vals = inner._def.values ?? [];
      return vals.map(v => JSON.stringify(v)).join(' | ');
    }
    case 'enum': {
      const entries = inner._def.entries ?? {};
      return Object.values(entries).map(v => `\`"${v}"\``).join(' \\| ');
    }
    case 'unknown': return 'unknown';
    case 'any':     return 'any';
    case 'array':   return 'array';
    case 'object':  return 'object';
    case 'record':  return 'object';
    case 'never':   return 'never';
    case 'null':    return 'null';
    default:        return t || 'unknown';
  }
}

/**
 * Render the argument table for a single tool's schema shape.
 * Returns a markdown table string.
 */
function renderTable(schema) {
  // Zod v4: schema.shape is a getter that returns the shape object
  const shape = schema?.shape ?? schema;
  if (!shape || typeof shape !== 'object' || Object.keys(shape).length === 0) {
    return '_No arguments._';
  }

  const rows = [];
  for (const [fieldName, zodType] of Object.entries(shape)) {
    const { inner, optional, hasDefault, defaultVal, description } = unwrap(zodType);
    const label = typeLabel(inner);

    // Build type cell: optional fields get "?", defaults show "= val"
    let typeCell = label;
    if (optional || hasDefault) {
      typeCell = `${label}?`;
    }
    if (hasDefault) {
      typeCell += ` = ${JSON.stringify(defaultVal)}`;
    }

    rows.push(`| \`${fieldName}\` | ${typeCell} | ${description} |`);
  }

  const header = '| Arg | Type | Description |\n|---|---|---|';
  return header + '\n' + rows.join('\n');
}

// ---------------------------------------------------------------------------
// Read docs/tools.md and replace slot contents
// ---------------------------------------------------------------------------

const docsPath = resolve(ROOT, 'docs/tools.md');
let docsContent = readFileSync(docsPath, 'utf-8');
const originalContent = docsContent;

const checkMode = process.argv.includes('--check');

// Process each registered tool
for (const [toolName, { schema }] of registry) {
  // Match the opening marker (with or without "manual")
  const openMarkerPattern = `<!-- GENERATED:tool:${toolName}`;
  const openIdx = docsContent.indexOf(openMarkerPattern);
  if (openIdx === -1) {
    console.error(
      `ERROR: No slot marker found for tool "${toolName}" in docs/tools.md.\n` +
      `Expected: <!-- GENERATED:tool:${toolName} --> ... <!-- /GENERATED:tool:${toolName} -->`,
    );
    process.exit(1);
  }

  // Find the end of the opening marker tag
  const openTagEnd = docsContent.indexOf('-->', openIdx);
  if (openTagEnd === -1) {
    console.error(`ERROR: Malformed opening marker for tool "${toolName}"`);
    process.exit(1);
  }
  const openTag = docsContent.slice(openIdx, openTagEnd + 3);

  // Skip manual slots
  if (openTag.includes(' manual')) {
    console.log(`  SKIP (manual): ${toolName}`);
    continue;
  }

  const closeMarker = `<!-- /GENERATED:tool:${toolName} -->`;
  const closeIdx = docsContent.indexOf(closeMarker, openTagEnd);
  if (closeIdx === -1) {
    console.error(
      `ERROR: No closing slot marker for tool "${toolName}" in docs/tools.md.\n` +
      `Expected: ${closeMarker}`,
    );
    process.exit(1);
  }

  const table = renderTable(schema);
  const newSlot = openTag + '\n' + table + '\n' + closeMarker;

  docsContent =
    docsContent.slice(0, openIdx) +
    newSlot +
    docsContent.slice(closeIdx + closeMarker.length);
}

// ---------------------------------------------------------------------------
// Write or diff
// ---------------------------------------------------------------------------

if (checkMode) {
  if (docsContent !== originalContent) {
    console.error(
      'DRIFT DETECTED: docs/tools.md is out of sync with Zod schemas.\n' +
      'Run `tsx scripts/gen-tools-docs.mjs` to regenerate.',
    );
    const orig = originalContent.split('\n');
    const next = docsContent.split('\n');
    let diffs = 0;
    for (let i = 0; i < Math.max(orig.length, next.length); i++) {
      if (orig[i] !== next[i]) {
        console.error(`  L${i+1}: - ${orig[i] ?? '(missing)'}`);
        console.error(`  L${i+1}: + ${next[i] ?? '(missing)'}`);
        if (++diffs >= 10) { console.error('  ... (truncated)'); break; }
      }
    }
    process.exit(1);
  }
  console.log('OK: docs/tools.md is in sync with Zod schemas.');
  process.exit(0);
}

writeFileSync(docsPath, docsContent, 'utf-8');
console.log(`Updated docs/tools.md (${registry.size} tools processed).`);
