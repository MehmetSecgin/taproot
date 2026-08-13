import type { QueryExecutionRequest } from '../core/execute-query.js';

export type QueryRoute = 'direct' | 'daemon';

export function queryRoute(request: QueryExecutionRequest): QueryRoute {
  if (process.env.TAPROOT_FORCE_DIRECT === '1') return 'direct';
  if (request.allowDiscovery) return 'direct';
  return 'daemon';
}
