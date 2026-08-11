import type { AppContext } from '../core/app.js';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import type { QueryOutcomeMeta, QuerySuccessData, QueryExecutionRequest } from '../core/execute-query.js';
import type { ProgressReporter } from '../core/progress.js';
import { str } from '../core/strings.js';
import { rpcCall } from '../daemon/client.js';
import { RpcMethod } from '../daemon/types.js';
import type { RpcResponse } from '../daemon/types.js';
import { presentQueryOutcome, queryFailureError } from './query-present.js';
import type { QueryOpts } from './query-types.js';

export type DaemonOutcome = 'handled' | 'fallback';

export async function runDaemonQuery(input: {
  request: QueryExecutionRequest;
  ctx: AppContext;
  opts: QueryOpts;
  progress: ProgressReporter;
}): Promise<DaemonOutcome> {
  const { request, ctx, opts, progress } = input;
  const logVerbose = (msg: string): void => {
    if (!ctx.jsonMode && ctx.verbose) process.stderr.write(`[taproot] ${msg}\n`);
  };
  let rpc: RpcResponse;
  try {
    rpc = await rpcCall({
      timeoutMs: Math.max(RUNTIME_CONSTANTS.rpc.requestTimeoutMs, request.timeoutMs + 1000),
      method: RpcMethod.QueryExecute,
      params: { ...request },
    });
  } catch (error) {
    const msg = str((error as Error).message);
    if (!/(ENOENT|ECONNREFUSED|EPIPE|socket hang up)/i.test(msg)) {
      progress.fail('daemon query failed');
      throw error;
    }
    progress.update('daemon unavailable, falling back to direct mode');
    logVerbose(`daemon RPC unavailable (${msg})`);
    return 'fallback';
  }

  const meta = (rpc.meta || {}) as QueryOutcomeMeta;
  if (rpc.ok) {
    logVerbose(`daemon request=${rpc.requestId} session=${meta.sessionId || 'n/a'} run=${meta.runId || 'n/a'}`);
    presentQueryOutcome({
      outcome: { ok: true, data: (rpc.data || {}) as unknown as QuerySuccessData, meta },
      ctx,
      opts,
      progress,
      requestId: rpc.requestId,
    });
    return 'handled';
  }

  progress.fail(`query failed (${rpc.error?.code || 'GENERIC'})`);
  throw queryFailureError({
    ok: false,
    code: rpc.error?.code || 'GENERIC',
    message: rpc.error?.message || 'daemon query failed',
    details: rpc.error?.details,
    meta: { ...meta, requestId: rpc.requestId },
  });
}
