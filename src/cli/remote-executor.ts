import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { parseTimeoutMs, queryBudgetMs } from '../core/query-timeout.js';
import { queryExecutionRequest } from './query-request.js';
import { replyData } from './query-present.js';
import { remoteRpcCall } from '../daemon/client.js';
import type { MutualTlsFiles } from '../daemon/transport.js';
import { RpcMethod } from '../daemon/types.js';
import type { Executor } from './types.js';

export function remoteExecutor(daemon: { host: string; port: number; tls: MutualTlsFiles }): Executor {
  const call = (method: string, params: Record<string, unknown>, timeoutMs: number) =>
    remoteRpcCall({ server: { host: daemon.host, port: daemon.port }, tls: daemon.tls, method, params, timeoutMs });

  return {
    addOptions() {},

    async query(opts) {
      const timeoutMs = parseTimeoutMs(opts.timeout, RUNTIME_CONSTANTS.query.defaultTimeoutMs);
      const targetAsTyped = { env: opts.env || '', namespace: opts.namespace || '', service: opts.service || '' };
      const request = queryExecutionRequest(opts, targetAsTyped, false, timeoutMs);
      return call(RpcMethod.QueryExecute, { ...request }, queryBudgetMs(timeoutMs) + RUNTIME_CONSTANTS.rpc.queryReplyMarginMs);
    },

    async listDatasources(request) {
      return replyData(await call(RpcMethod.DatasourceList, { ...request }, RUNTIME_CONSTANTS.rpc.requestTimeoutMs));
    },

    async readSchema(request) {
      return replyData(await call(RpcMethod.SchemaRead, { ...request }, queryBudgetMs(RUNTIME_CONSTANTS.query.catalogTimeoutMs)));
    },
  };
}
