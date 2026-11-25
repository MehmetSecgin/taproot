import type { QueryExecutionRequest } from '../core/query-types.js';
import { defaultSocketPath } from '../daemon/socket-path.js';

const MAX_UNIX_SOCKET_PATH_BYTES = 103;

type QueryRoute = 'direct' | 'daemon';

export function daemonRouteIfAvailable(): QueryRoute {
  if (process.env.TAPROOT_FORCE_DIRECT === '1') {
    return 'direct';
  }
  if (Buffer.byteLength(defaultSocketPath()) > MAX_UNIX_SOCKET_PATH_BYTES) {
    return 'direct';
  }
  return 'daemon';
}

export function queryRoute(request: QueryExecutionRequest): QueryRoute {
  return request.allowDiscovery ? 'direct' : daemonRouteIfAvailable();
}
