/**
 * Shared types + hint generators for the v1.5.0 `next_actions` envelope.
 *
 * Design: tools opt in by wrapping their return value as
 * `{ data, context: { state, next_actions } }`. Clients parsing the JSON see
 * `context.next_actions` and can route the agent's next call without asking.
 * Backwards compat is trivial — clients ignoring `context` keep working.
 */

export interface StateTokens {
  last_search_query?: string;
  last_search_results?: string[];
  last_file_read?: string;
  last_file_outgoing?: string[];
  last_file_unresolved_links?: string[];
  last_connections_root?: string;
  last_connections_count?: number;
}

export interface NextAction {
  description: string;
  tool: string;
  args: Record<string, unknown>;
  reason: string;
}

export interface ToolContext {
  state?: Partial<StateTokens>;
  next_actions?: NextAction[];
}

export interface ContextualResult<T> {
  data: T;
  context: ToolContext;
}

export function isContextualResult(r: unknown): r is ContextualResult<unknown> {
  return (
    typeof r === 'object' &&
    r !== null &&
    'data' in r &&
    'context' in r &&
    typeof (r as { context: unknown }).context === 'object'
  );
}

export interface SearchHintHit {
  nodeId: string;
  title?: string;
  score?: number;
}

const FIND_CONNECTIONS_CLUSTER_THRESHOLD = 10;

export function computeSearchHints(
  query: string,
  results: SearchHintHit[],
): ToolContext {
  if (results.length === 0) {
    const simplified = simplifyQuery(query);
    const next_actions: NextAction[] = [];
    if (simplified && simplified !== query) {
      next_actions.push({
        description: 'Retry with broader phrasing',
        tool: 'search',
        args: { query: simplified },
        reason: 'No hits for this specific query — try broader phrasing',
      });
    }
    return {
      state: { last_search_query: query, last_search_results: [] },
      next_actions,
    };
  }

  const top = results[0]!;
  const topTitle = top.title ?? top.nodeId;
  const next_actions: NextAction[] = [
    {
      description: `Read the top hit: ${topTitle}`,
      tool: 'read_note',
      args: { name: top.nodeId },
      reason:
        top.score !== undefined
          ? `${topTitle} scored ${top.score.toFixed(3)}`
          : `${topTitle} is the top-ranked result`,
    },
  ];
  if (results.length >= 2) {
    next_actions.push({
      description: `Explore connections of top hit: ${topTitle}`,
      tool: 'find_connections',
      args: { name: top.nodeId, depth: 2 },
      reason: `Top-${Math.min(results.length, 3)} results cluster around ${topTitle} — trace its graph neighbourhood`,
    });
  }

  return {
    state: {
      last_search_query: query,
      last_search_results: results.slice(0, 10).map((r) => r.nodeId),
    },
    next_actions,
  };
}

export interface ReadNoteHintInput {
  id: string;
  outgoing: string[];
  unresolvedLinks: string[];
}

export function computeReadNoteHints(note: ReadNoteHintInput): ToolContext {
  const next_actions: NextAction[] = [];

  if (note.unresolvedLinks.length > 0) {
    const first = note.unresolvedLinks[0]!;
    next_actions.push({
      description: `Create missing note: ${first}`,
      tool: 'create_note',
      args: { title: first },
      reason: `Note has ${note.unresolvedLinks.length} unresolved [[...]] link${note.unresolvedLinks.length === 1 ? '' : 's'} — create '${first}' to resolve`,
    });
  }

  if (note.outgoing.length > 0) {
    next_actions.push({
      description: `Explore outgoing links from ${note.id}`,
      tool: 'find_connections',
      args: { name: note.id },
      reason: `Explore the ${note.outgoing.length} note${note.outgoing.length === 1 ? '' : 's'} this one links out to`,
    });
  }

  return {
    state: {
      last_file_read: note.id,
      last_file_outgoing: note.outgoing,
      last_file_unresolved_links: note.unresolvedLinks,
    },
    next_actions,
  };
}

export interface FindConnectionsHintNeighbor {
  id: string;
  title?: string;
}

export function computeFindConnectionsHints(
  root: string,
  connections: FindConnectionsHintNeighbor[],
): ToolContext {
  const next_actions: NextAction[] = [];

  if (connections.length > FIND_CONNECTIONS_CLUSTER_THRESHOLD) {
    next_actions.push({
      description: 'Cluster these connections into themes',
      tool: 'detect_themes',
      args: {},
      reason: `${connections.length} connections — consider clustering to see structure`,
    });
  }

  if (connections.length > 0) {
    const furthest = connections[connections.length - 1]!;
    if (furthest.id !== root) {
      next_actions.push({
        description: `Trace path from ${root} to ${furthest.title ?? furthest.id}`,
        tool: 'find_path_between',
        args: { source: root, target: furthest.id },
        reason: `Find the shortest link chain to the furthest neighbour in this subgraph`,
      });
    }
  }

  return {
    state: {
      last_connections_root: root,
      last_connections_count: connections.length,
    },
    next_actions,
  };
}

/**
 * Drop common stopwords + trim quoted phrases. Not clever — just enough to
 * produce a looser query when the literal one returned zero hits.
 */
function simplifyQuery(query: string): string {
  const stripped = query.replace(/["']/g, '').trim();
  const stopwords = new Set([
    'the',
    'a',
    'an',
    'of',
    'on',
    'in',
    'and',
    'or',
    'to',
    'for',
    'with',
    'about',
  ]);
  const tokens = stripped
    .split(/\s+/)
    .filter((t) => t.length > 0 && !stopwords.has(t.toLowerCase()));
  if (tokens.length <= 2) return stripped;
  return tokens.slice(0, Math.max(2, Math.ceil(tokens.length / 2))).join(' ');
}
