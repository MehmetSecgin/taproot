import { DoctorStatus } from '../../types/plugin.js';
import type { DoctorCheck, TapRootPlugin } from '../../types/plugin.js';
import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { classifyExecutorDoctorCode } from '../../core/executor-errors.js';
import { firstNonEmpty } from '../../core/text-presence.js';
import { truncateDetail } from '../_shared/truncate-detail.js';
import { buildRedisCliInvocation, runRedisCli } from './cli.js';

const DOCTOR_PING_GRACE_MS = 2000;

export async function pingRedis(input: Parameters<NonNullable<TapRootPlugin['doctor']>>[0]): Promise<DoctorCheck[]> {
  const invocation = buildRedisCliInvocation({
    datasource: input.datasource,
    credentials: input.credentials,
    command: ['PING'],
    quoteBulkReplies: false,
  });
  const run = await runRedisCli(invocation, {
    timeoutMs: RUNTIME_CONSTANTS.plugin.dbConnectTimeoutMs + DOCTOR_PING_GRACE_MS,
    signal: undefined,
  });
  if (run.code === 0 && /PONG/iu.test(run.stdout)) {
    return [{ check: 'redis ping', status: DoctorStatus.Ok, detail: 'PING -> PONG' }];
  }
  const output = firstNonEmpty(run.stderr, run.stdout) ?? `exit=${run.code}`;
  const truncated = truncateDetail(output.trim());
  const detail = truncated === '' ? 'redis-cli failed' : truncated;
  return [{ check: 'redis ping', status: DoctorStatus.Fail, detail, code: classifyExecutorDoctorCode(detail) }];
}
