import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { parseTimeoutMs } from '../core/query-timeout.js';
import { remoteRpcCall } from '../daemon/client.js';
import type { MutualTlsFiles } from '../daemon/transport.js';
import { RpcMethod } from '../daemon/types.js';
import type { RpcResponse } from '../daemon/types.js';
import { dataOrThrow } from './query-reply.js';
import { queryExecutionRequest } from './query-request.js';
import { queryRpcTimeoutMs, schemaRpcTimeoutMs } from './rpc-timeouts.js';
import type { Executor } from './types.js';

const addNoOptions = (): undefined => undefined;

export function remoteExecutor(remote: { host: string; port: number; tls: MutualTlsFiles }): Executor {
  const call = async (method: string, params: Record<string, unknown>, timeoutMs: number): Promise<RpcResponse> =>
    remoteRpcCall({ server: { host: remote.host, port: remote.port }, tls: remote.tls, method, params, timeoutMs });

  return {
    addOptions: addNoOptions,

    async query(opts) {
      const timeoutMs = parseTimeoutMs(opts.timeout, RUNTIME_CONSTANTS.query.defaultTimeoutMs);
      const unnormalizedTarget = { env: opts.env ?? '', namespace: opts.namespace ?? '', service: opts.service ?? '' };
      const request = queryExecutionRequest(opts, { target: unnormalizedTarget, allowDiscovery: false, timeoutMs });
      return call(RpcMethod.QueryExecute, { ...request }, queryRpcTimeoutMs(timeoutMs));
    },

    async listDatasources(request) {
      return dataOrThrow(await call(RpcMethod.DatasourceList, { ...request }, RUNTIME_CONSTANTS.rpc.requestTimeoutMs));
    },

    async readSchema(request) {
      return dataOrThrow(await call(RpcMethod.SchemaRead, { ...request }, schemaRpcTimeoutMs()));
    },
  };
}
