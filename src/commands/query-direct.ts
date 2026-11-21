import { randomUUID } from 'node:crypto';
import type { AppContext } from '../core/app.js';
import { discoverKubernetesTargets } from '../core/discovery.js';
import { executeQuery } from '../core/execute-query.js';
import type { QueryExecutionRequest } from '../core/execute-query.js';
import { queryDatasourceResolver } from '../core/resolve-query-datasource.js';
import { outcomeReply, type DaemonReply } from './query-present.js';

export function verboseLog(ctx: AppContext): (msg: string) => void {
  return (msg) => {
    if (ctx.verbose) process.stderr.write(`${JSON.stringify({ verbose: msg })}\n`);
  };
}

export async function runDirectQuery(request: QueryExecutionRequest, ctx: AppContext): Promise<DaemonReply> {
  const outcome = await executeQuery(request, {
    ctx,
    report: { log: verboseLog(ctx) },
    signal: undefined,
    acquireQuerySlot: undefined,
    resolveDatasource: queryDatasourceResolver(discoverKubernetesTargets),
  });
  return outcomeReply(outcome, randomUUID());
}
