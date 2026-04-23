/**
 * Spy helpers for the fire-and-forget reindex path.
 *
 * `spyIndexCalls` replaces ctx.pipeline.index with a recorder so a test can
 * assert that pipeline.index was eventually called. `waitForIndexCall` polls
 * the recorder until it sees a call or times out.
 */

import type { ServerContext } from '../../src/context.js';

export function spyIndexCalls(ctx: ServerContext): { indexCalls: string[] } {
  const indexCalls: string[] = [];
  ctx.pipeline.index = async (p: string) => {
    indexCalls.push(p);
    return {
      nodesIndexed: 0,
      nodesSkipped: 0,
      edgesIndexed: 0,
      communitiesDetected: 0,
      stubNodesCreated: 0,
    };
  };
  return { indexCalls };
}

export function waitForIndexCall(
  indexCalls: string[],
  timeoutMs = 10_000,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const start = Date.now();
    const poll = (): void => {
      if (indexCalls.length > 0) {
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error(`waitForIndexCall: no call within ${timeoutMs}ms`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}
