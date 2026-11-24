import type { QueryExecutionRequest } from '../core/query-types.js';
import type { SchemaRequest } from '../core/schema-read.js';
import { rpcCall } from '../daemon/client.js';
import { spawnDaemon } from '../daemon/spawn.js';
import { DAEMON_VERSION_MISMATCH, RpcMethod } from '../daemon/types.js';
import type { RpcResponse } from '../daemon/types.js';
import { queryRpcTimeoutMs, schemaRpcTimeoutMs } from './rpc-timeouts.js';
import type { VerboseLog } from './verbose-log.js';
import { nonEmptyOr } from '../core/text-presence.js';

const DAEMON_UNREACHABLE_PATTERN = /(?:ENOENT|ECONNREFUSED|EINVAL|ENAMETOOLONG|EPIPE|socket hang up)/iu;

type DaemonCall = { method: string; params: Record<string, unknown>; timeoutMs: number };

function unreachableReason(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : '';
  return DAEMON_UNREACHABLE_PATTERN.test(message) ? message : undefined;
}

function replyUnlessVersionMismatch(response: RpcResponse, logVerbose: VerboseLog): RpcResponse | undefined {
  if (response.error?.code !== DAEMON_VERSION_MISMATCH) {
    return response;
  }
  logVerbose(response.error.message);
  return undefined;
}

async function callDaemonIfReachable(call: DaemonCall, logVerbose: VerboseLog): Promise<RpcResponse | undefined> {
  try {
    return replyUnlessVersionMismatch(await rpcCall(call), logVerbose);
  } catch (error) {
    const reason = unreachableReason(error);
    if (reason === undefined) {
      throw error;
    }
    logVerbose(`daemon RPC unavailable (${reason})`);
    return undefined;
  }
}

async function callDaemonStartingIfDown(call: DaemonCall, logVerbose: VerboseLog): Promise<RpcResponse | undefined> {
  let response = await callDaemonIfReachable(call, logVerbose);
  if (!response) {
    logVerbose('starting taprootd');
    if (await spawnDaemon()) {
      response = await callDaemonIfReachable(call, logVerbose);
    }
  }
  if (!response) {
    logVerbose('daemon unavailable, falling back to direct mode');
  }
  return response;
}

export async function queryThroughDaemon(request: QueryExecutionRequest, logVerbose: VerboseLog): Promise<RpcResponse | undefined> {
  const reply = await callDaemonStartingIfDown(
    { method: RpcMethod.QueryExecute, params: { ...request }, timeoutMs: queryRpcTimeoutMs(request.timeoutMs) },
    logVerbose,
  );
  if (reply?.ok === true) {
    logVerbose(`daemon request=${reply.requestId} session=${nonEmptyOr(reply.meta?.sessionId, 'n/a')}`);
  }
  return reply;
}

export async function readSchemaThroughDaemon(request: SchemaRequest, logVerbose: VerboseLog): Promise<RpcResponse | undefined> {
  const params = { datasource: request.datasource, tables: request.tables };
  return callDaemonStartingIfDown({ method: RpcMethod.SchemaRead, params, timeoutMs: schemaRpcTimeoutMs() }, logVerbose);
}
