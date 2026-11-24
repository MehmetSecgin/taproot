import { randomUUID } from 'node:crypto';
import type { AppContext } from '../core/app.js';
import { discoverKubernetesTargets } from '../core/kubernetes-target-discovery.js';
import { executeQuery } from '../core/execute-query.js';
import type { QueryExecutionRequest } from '../core/query-types.js';
import { queryDatasourceResolver } from '../core/resolve-query-datasource.js';
import { outcomeReply } from './query-reply.js';
import type { QueryReply } from './query-reply.js';
import { createVerboseLog } from './verbose-log.js';

export async function runDirectQuery(request: QueryExecutionRequest, ctx: AppContext): Promise<QueryReply> {
  const outcome = await executeQuery(request, {
    ctx,
    report: { log: createVerboseLog(ctx) },
    signal: undefined,
    acquireQuerySlot: undefined,
    resolveDatasource: queryDatasourceResolver(discoverKubernetesTargets),
  });
  return outcomeReply(outcome, randomUUID());
}
