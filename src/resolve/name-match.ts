import type { DatabaseHandle } from '../store/db.js';
import type { NameMatch } from '../types.js';

export function resolveNodeName(name: string, db: DatabaseHandle): NameMatch[] {
  const allNodes = db.prepare(
    'SELECT id, title, frontmatter FROM nodes'
  ).all() as Array<{ id: string; title: string; frontmatter: string }>;

  // Priority 0: exact ID match (with or without .md extension)
  const nameWithMd = name.endsWith('.md') ? name : name + '.md';
  const idMatch = allNodes.filter(n => n.id === name || n.id === nameWithMd);
  if (idMatch.length > 0) {
    return idMatch.map(n => ({ nodeId: n.id, title: n.title, matchType: 'id' as const }));
  }

  // Priority 1: exact title match
  const exact = allNodes.filter(n => n.title === name);
  if (exact.length > 0) {
    return exact.map(n => ({ nodeId: n.id, title: n.title, matchType: 'exact' as const }));
  }

  // Priority 1b: filename basename match (Obsidian-style: users reference
  // notes by the last path segment sans `.md`, which often differs from the
  // indexed title — e.g. after move_note renames the file but not the H1).
  const basenameStripped = name.replace(/\.md$/, '');
  const basenameMatch = allNodes.filter((n) => {
    const base = n.id.split('/').pop() ?? n.id;
    return base === name || base === basenameStripped + '.md';
  });
  if (basenameMatch.length > 0) {
    return basenameMatch.map((n) => ({ nodeId: n.id, title: n.title, matchType: 'id' as const }));
  }

  // Priority 2: case-insensitive title match
  const lower = name.toLowerCase();
  const caseInsensitive = allNodes.filter(n => n.title.toLowerCase() === lower);
  if (caseInsensitive.length > 0) {
    return caseInsensitive.map(n => ({
      nodeId: n.id, title: n.title, matchType: 'case-insensitive' as const,
    }));
  }

  // Priority 3: alias match
  const aliasMatches: NameMatch[] = [];
  for (const n of allNodes) {
    const fm = JSON.parse(n.frontmatter);
    const aliases: string[] = fm.aliases ?? [];
    if (aliases.some(a => a.toLowerCase() === lower)) {
      aliasMatches.push({ nodeId: n.id, title: n.title, matchType: 'alias' });
    }
  }
  if (aliasMatches.length > 0) return aliasMatches;

  // Priority 4: substring match on title
  const substring = allNodes.filter(n => n.title.toLowerCase().includes(lower));
  return substring.map(n => ({
    nodeId: n.id, title: n.title, matchType: 'substring' as const,
  }));
}
