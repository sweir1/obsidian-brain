// Graphology's v0.x default-export typings don't reconcile with strict TS under
// NodeNext: TS sees the default export as a namespace, not a constructor. The
// same applies to `graphology-metrics/*/*` and `graphology-communities-louvain`,
// whose default exports are callable at runtime but typed as namespaces.
//
// Rather than pepper every file with `as any` we confine the cast to this module.
// Downstream code imports a typed-enough class + function signatures and never
// has to know about the quirk.

import GraphImport from 'graphology';
import louvainImport from 'graphology-communities-louvain';
import pagerankImport from 'graphology-metrics/centrality/pagerank.js';
import betweennessImport from 'graphology-metrics/centrality/betweenness.js';
import modularityImport from 'graphology-metrics/graph/modularity.js';

export type GraphOptions = {
  multi?: boolean;
  type?: 'directed' | 'undirected' | 'mixed';
};

export interface GraphInstance {
  readonly order: number;
  readonly size: number;
  addNode(id: string, attrs?: Record<string, unknown>): void;
  addEdge(source: string, target: string, attrs?: Record<string, unknown>): void;
  hasNode(id: string): boolean;
  hasEdge(source: string, target: string): boolean;
  getNodeAttribute(id: string, key: string): unknown;
  getEdgeAttribute(source: string, target: string, key: string): unknown;
  getEdgeAttribute(edgeKey: string, key: string): unknown;
  forEachNode(cb: (id: string, attrs: Record<string, unknown>) => void): void;
  forEachEdge(
    cb: (
      edge: string,
      attrs: Record<string, unknown>,
      source: string,
      target: string,
    ) => void,
  ): void;
  outNeighbors(id: string): string[];
  inNeighbors(id: string): string[];
  neighbors(id: string): string[];
  degree(id: string): number;
  nodes(): string[];
  edges(): string[];
  edges(source: string, target: string): string[];
}

type GraphCtor = new (options?: GraphOptions) => GraphInstance;

export const Graph = GraphImport as unknown as GraphCtor;

export const louvain = louvainImport as unknown as (
  graph: GraphInstance,
  options?: { resolution?: number; rng?: () => number },
) => Record<string, number>;

export const pageRankFn = pagerankImport as unknown as (
  graph: GraphInstance,
  options?: { maxIterations?: number; tolerance?: number },
) => Record<string, number>;

export const betweennessFn = betweennessImport as unknown as (
  graph: GraphInstance,
) => Record<string, number>;

/**
 * Modularity scorer from graphology-metrics. Signed in terms of our own
 * `GraphInstance` for consistency with other helpers. `getNodeCommunity`
 * accepts either an attribute name or a mapper `(node, attrs) => id`.
 */
export const louvainModularity = modularityImport as unknown as (
  graph: GraphInstance,
  options?: {
    getNodeCommunity?:
      | string
      | ((node: string, attrs: Record<string, unknown>) => string | number);
    resolution?: number;
  },
) => number;
