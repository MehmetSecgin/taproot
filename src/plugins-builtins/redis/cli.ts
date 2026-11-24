import { spawn } from 'node:child_process';
import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { spawnErrorMessage } from '../../core/executor-errors.js';
import { queryTimeoutError } from '../../core/query-timeout.js';
import type { QueryRequest } from '../../types/plugin.js';
import { connectionHost, connectionPort } from '../_shared/connection-endpoint.js';
import { firstNonEmpty, isNonEmpty } from '../../core/text-presence.js';
import { hasDatabase } from '../../core/has-database.js';

type RedisCliInvocation = {
  args: string[];
  env: NodeJS.ProcessEnv;
};

type RunOptions = {
  timeoutMs: number | undefined;
  signal: AbortSignal | undefined;
};

export type RedisCliRun = { stdout: string; stderr: string; code: number; timedOut: boolean };

export type RedisCliRequest = {
  datasource: QueryRequest['datasource'];
  credentials: Record<string, string>;
  command: string[];
  quoteBulkReplies: boolean;
};

function databaseArgs(database: unknown): string[] {
  return hasDatabase(database) ? ['-n', String(database)] : [];
}

function userArgs(user: string | undefined): string[] {
  return isNonEmpty(user) ? ['--user', user] : [];
}

function authEnvironment(password: string | undefined): NodeJS.ProcessEnv {
  return isNonEmpty(password) ? { ...process.env, REDISCLI_AUTH: password } : process.env;
}

export function buildRedisCliInvocation({ datasource, credentials, command, quoteBulkReplies }: RedisCliRequest): RedisCliInvocation {
  const { connection } = datasource;
  const args = [
    '-h', connectionHost(connection),
    '-p', String(connectionPort(connection, RUNTIME_CONSTANTS.defaultPorts.redis)),
    '--no-auth-warning',
    ...(quoteBulkReplies ? ['--no-raw'] : []),
    ...databaseArgs(connection.database),
    ...userArgs(credentials.user),
    ...(connection.ssl === true ? ['--tls'] : []),
    ...command,
  ];
  return { args, env: authEnvironment(credentials.password) };
}

export async function runRedisCli(invocation: RedisCliInvocation, { timeoutMs, signal }: RunOptions): Promise<RedisCliRun> {
  return new Promise((resolve) => {
    const proc = spawn('redis-cli', invocation.args, { env: invocation.env, stdio: ['ignore', 'pipe', 'pipe'], signal, killSignal: 'SIGKILL' });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = timeoutMs !== undefined && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          proc.kill('SIGKILL');
        }, timeoutMs)
      : undefined;
    const finish = (run: RedisCliRun): void => {
      clearTimeout(timer);
      resolve(run);
    };
    proc.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    proc.once('error', (error) => {
      finish({ stdout, stderr: spawnErrorMessage(error), code: -1, timedOut });
    });
    proc.once('exit', (code) => {
      finish({ stdout, stderr, code: code ?? -1, timedOut });
    });
  });
}

export function redisCliFailure(run: RedisCliRun, timeoutMs: number | undefined): Error | undefined {
  if (run.timedOut) {
    return queryTimeoutError(timeoutMs ?? 0);
  }
  if (run.code !== 0) {
    return new Error((firstNonEmpty(run.stderr, run.stdout) ?? `redis-cli exit ${run.code}`).trim());
  }
  if (/^\(error\)/imu.test(run.stdout)) {
    return new Error(run.stdout.trim());
  }
  return undefined;
}
