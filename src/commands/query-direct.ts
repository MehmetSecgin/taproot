import { randomUUID } from 'node:crypto';
import type { AppContext } from '../core/app.js';
import { executeQuery } from '../core/execute-query.js';
import type { QueryExecutionRequest } from '../core/execute-query.js';
import { presentQueryOutcome } from './query-present.js';

export function verboseLog(ctx: AppContext): (msg: string) => void {
  return (msg) => {
    if (ctx.verbose) process.stderr.write(`${JSON.stringify({ verbose: msg })}\n`);
  };
}


export async function runDirectQuery(request: QueryExecutionRequest, ctx: AppContext): Promise<void> {
  const outcome = await executeQuery(request, { ctx, report: { log: verboseLog(ctx) }, signal: undefined, acquireQuerySlot: undefined });
  presentQueryOutcome(outcome, randomUUID());
}
