import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { queryBudgetMs } from '../core/query-timeout.js';

export function queryRpcTimeoutMs(queryTimeoutMs: number): number {
  return queryBudgetMs(queryTimeoutMs) + RUNTIME_CONSTANTS.rpc.queryReplyMarginMs;
}

export function schemaRpcTimeoutMs(): number {
  return queryBudgetMs(RUNTIME_CONSTANTS.query.catalogTimeoutMs);
}
