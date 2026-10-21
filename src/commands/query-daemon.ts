import type { AppContext } from '../core/app.js';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import type { QueryOutcomeMeta, QuerySuccessData, QueryExecutionRequest } from '../core/execute-query.js';
import { str } from '../core/strings.js';
import { rpcCall } from '../daemon/client.js';
import { spawnDaemon } from '../daemon/spawn.js';
import { DAEMON_VERSION_MISMATCH, RpcMethod } from '../daemon/types.js';
import type { RpcResponse } from '../daemon/types.js';
import { presentQueryOutcome, queryFailureError } from './query-present.js';
import { verboseLog } from './query-direct.js';

export type DaemonOutcome = 'handled' | 'fallback';

export async function runDaemonQuery(request: QueryExecutionRequest, ctx: AppContext): Promise<DaemonOutcome> {
  const logVerbose = verboseLog(ctx);
  const callDaemon = async (): Promise<RpcResponse | undefined> => {
    try {
      const res = await rpcCall({
        timeoutMs: Math.max(RUNTIME_CONSTANTS.rpc.requestTimeoutMs, request.timeoutMs + 1000),
        method: RpcMethod.QueryExecute,
        params: { ...request },
      });
      if (res.error?.code !== DAEMON_VERSION_MISMATCH) return res;
      logVerbose(res.error.message);
      return undefined;
    } catch (error) {
      const msg = str((error as Error).message);
      if (!/(ENOENT|ECONNREFUSED|EINVAL|ENAMETOOLONG|EPIPE|socket hang up)/i.test(msg)) {
        throw error;
      }
      logVerbose(`daemon RPC unavailable (${msg})`);
      return undefined;
    }
  };
  let rpc = await callDaemon();
  if (!rpc) {
    logVerbose('starting taprootd');
    if (await spawnDaemon()) rpc = await callDaemon();
  }
  if (!rpc) {
    logVerbose('daemon unavailable, falling back to direct mode');
    return 'fallback';
  }

  const meta = (rpc.meta || {}) as QueryOutcomeMeta;
  if (rpc.ok) {
    logVerbose(`daemon request=${rpc.requestId} session=${meta.sessionId || 'n/a'} run=${meta.runId || 'n/a'}`);
    presentQueryOutcome({ ok: true, data: (rpc.data || {}) as unknown as QuerySuccessData, meta }, rpc.requestId);
    return 'handled';
  }

  throw queryFailureError({
    ok: false,
    code: rpc.error?.code || 'GENERIC',
    message: rpc.error?.message || 'daemon query failed',
    details: rpc.error?.details,
    meta: { ...meta, requestId: rpc.requestId },
  });
}
