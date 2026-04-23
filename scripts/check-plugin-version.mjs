#!/usr/bin/env node
/**
 * scripts/check-plugin-version.mjs
 *
 * Advisory check: server package.json version and companion plugin
 * manifest.json must agree on major.minor (patch drift is fine).
 *
 * Exits:
 *   0 — versions match (or plugin directory not found, or SKIP_PLUGIN_CHECK=1)
 *   1 — major.minor mismatch
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Allow callers to bypass this check (e.g. in CI where the sibling repo
// isn't checked out, or when intentionally bumping versions out of sync).
if (process.env.SKIP_PLUGIN_CHECK === '1') {
  console.log('check-plugin: skipped (SKIP_PLUGIN_CHECK=1)');
  process.exit(0);
}

// Read server version
const serverPkg = JSON.parse(readFileSync(resolve(ROOT, 'package.json'), 'utf-8'));
const serverVersion = serverPkg.version;

// Try to locate the companion plugin
const pluginManifestPath = resolve(ROOT, '../obsidian-brain-plugin/manifest.json');

let pluginManifest;
try {
  pluginManifest = JSON.parse(readFileSync(pluginManifestPath, 'utf-8'));
} catch {
  console.warn(
    `check-plugin: companion plugin not found at ${pluginManifestPath} — skipping (advisory only).`,
  );
  process.exit(0);
}

const pluginVersion = pluginManifest.version;

// Parse major.minor from a semver string like "1.6.7" or "1.6.7-beta.1"
function majorMinor(v) {
  const [major, minor] = v.split('.');
  return `${major}.${minor}`;
}

const serverMM = majorMinor(serverVersion);
const pluginMM = majorMinor(pluginVersion);

if (serverMM !== pluginMM) {
  console.error(
    `check-plugin: MISMATCH\n` +
    `  Server  v${serverVersion} (major.minor = ${serverMM})\n` +
    `  Plugin  v${pluginVersion} (major.minor = ${pluginMM})\n` +
    `\n` +
    `Server v${serverVersion} does not match plugin v${pluginVersion} on major.minor — ` +
    `bump plugin to ${serverMM}.x or skip this check with SKIP_PLUGIN_CHECK=1.`,
  );
  process.exit(1);
}

console.log(
  `check-plugin: OK — server v${serverVersion} and plugin v${pluginVersion} agree on major.minor (${serverMM}).`,
);
process.exit(0);
