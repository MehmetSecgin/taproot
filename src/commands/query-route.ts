import type { QueryExecutionRequest } from '../core/execute-query.js';
import { defaultSocketPath } from '../daemon/client.js';

const MAX_UNIX_SOCKET_PATH_BYTES = 103;

export type QueryRoute = 'direct' | 'daemon';

export function queryRoute(request: QueryExecutionRequest): QueryRoute {
  if (process.env.TAPROOT_FORCE_DIRECT === '1') return 'direct';
  if (request.allowDiscovery) return 'direct';
  if (Buffer.byteLength(defaultSocketPath()) > MAX_UNIX_SOCKET_PATH_BYTES) return 'direct';
  return 'daemon';
}
