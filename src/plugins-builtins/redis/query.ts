import type { QueryRequest } from '../../types/plugin.js';
import { buildRedisCliInvocation, redisCliFailure, runRedisCli } from './cli.js';
import type { RedisCliRequest, RedisCliRun } from './cli.js';
import { splitRedisCommandLine } from './command-line.js';
import { KEY_NAME_REPLY_COMMANDS, assertCommandAllowed } from './command-policy.js';
import { assertDatabaseSet, gateOptionsFor, resolveProtoDecoding } from './request-options.js';
import { buildValueRows } from './reply-decode.js';

async function runRedisCommand(request: QueryRequest, cliRequest: RedisCliRequest): Promise<RedisCliRun> {
  const run = await runRedisCli(buildRedisCliInvocation(cliRequest), { timeoutMs: request.timeoutMs, signal: request.signal });
  const failure = redisCliFailure(run, request.timeoutMs);
  if (failure !== undefined) {
    request.signal?.throwIfAborted();
    throw failure;
  }
  return run;
}

export async function queryRedis(request: QueryRequest, credentials: Record<string, string>): Promise<{ rows: unknown[][]; warnings: string[] }> {
  const tokens = splitRedisCommandLine(request.query);
  const { verb, tier } = assertCommandAllowed(tokens, gateOptionsFor(request));
  assertDatabaseSet(request.datasource);
  const protoDecoding = resolveProtoDecoding(request);
  const decodeReplies = protoDecoding !== undefined && tier === 'read' && !KEY_NAME_REPLY_COMMANDS.has(verb);
  const run = await runRedisCommand(request, { datasource: request.datasource, credentials, command: tokens, quoteBulkReplies: decodeReplies });
  return buildValueRows(run.stdout, decodeReplies ? protoDecoding : undefined);
}
