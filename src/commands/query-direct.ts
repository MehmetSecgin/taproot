import { randomUUID } from 'node:crypto';
import type { AppContext } from '../core/app.js';
import { executeQuery } from '../core/execute-query.js';
import type { QueryReport, QueryExecutionRequest } from '../core/execute-query.js';
import { presentQueryOutcome } from './query-present.js';

export function verboseLog(ctx: AppContext): (msg: string) => void {
  return (msg) => {
    if (ctx.verbose) process.stderr.write(`[taproot] ${msg}\n`);
  };
}

function cliQueryReport(ctx: AppContext): QueryReport {
  const logVerbose = verboseLog(ctx);
  return {
    update: logVerbose,
    phase: (phase, ms) => logVerbose(`phase ${phase}: ${ms}ms`),
    verbose: logVerbose,
    notice: logVerbose,
  };
}

export async function runDirectQuery(request: QueryExecutionRequest, ctx: AppContext): Promise<void> {
  const outcome = await executeQuery(request, { ctx, report: cliQueryReport(ctx) });
  presentQueryOutcome(outcome, randomUUID());
}
