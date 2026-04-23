#!/usr/bin/env node
/**
 * Append a dated idea bullet to the Ideas section of docs/roadmap.md.
 *
 * Usage:
 *   node scripts/idea.mjs "your idea text here"
 *
 * Appends `- YYYY-MM-DD · <text>` before the <!-- IDEAS:end --> marker.
 * If the text is empty, prints usage and exits 1.
 * If markers are missing, errors clearly.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const MARKER_END = '<!-- IDEAS:end -->';

const text = process.argv.slice(2).join(' ').trim();

if (!text) {
  console.error(
    `Usage: node scripts/idea.mjs "your idea text"\n\n` +
    `Appends a dated idea bullet to the Ideas section of docs/roadmap.md.`
  );
  process.exit(1);
}

const roadmapPath = new URL('../docs/roadmap.md', import.meta.url);

let content;
try {
  content = readFileSync(roadmapPath, 'utf8');
} catch (e) {
  console.error(`idea: failed to read docs/roadmap.md — ${e.message}`);
  process.exit(1);
}

const endIdx = content.indexOf(MARKER_END);
if (endIdx === -1) {
  console.error(
    `idea: <!-- IDEAS:end --> marker not found in docs/roadmap.md.\n` +
    `Please add <!-- IDEAS:start --> and <!-- IDEAS:end --> markers to the Ideas section.`
  );
  process.exit(1);
}

const date   = new Date().toISOString().slice(0, 10);
const bullet = `- ${date} · ${text}\n`;

const newContent =
  content.slice(0, endIdx) +
  bullet +
  content.slice(endIdx);

writeFileSync(roadmapPath, newContent);
console.log(`idea: appended to docs/roadmap.md — ${bullet.trim()}`);
