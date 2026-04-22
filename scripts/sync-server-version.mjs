#!/usr/bin/env node
/**
 * Sync `server.json` version fields from `package.json` via the npm
 * `version` lifecycle hook, so `npm version patch` bumps both files
 * in the same commit.
 *
 * Uses a surgical regex replacement (not JSON round-trip) so the file's
 * existing formatting — compact inline objects like
 * `{ "type": "positional", "value": "-y" }` — is preserved. Only the
 * quoted value after `"version":` changes.
 *
 * Safe because obsidian-brain's server.json has exactly two `"version"`
 * fields (top-level + `packages[0].version`) and they always co-move.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const v = process.env.npm_package_version;
if (!v) {
  console.error('sync-server-version: npm_package_version not set — invoke via `npm version`.');
  process.exit(1);
}

const path = new URL('../server.json', import.meta.url);
const src = readFileSync(path, 'utf8');
const out = src.replace(/("version":\s*)"[^"]+"/g, `$1"${v}"`);
writeFileSync(path, out);
console.log(`sync-server-version: server.json → ${v}`);
