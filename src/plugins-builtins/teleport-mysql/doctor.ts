import { classifyExecutorDoctorCode } from '../../core/executor-errors.js';
import { DoctorStatus } from '../../types/plugin.js';
import type { DoctorCheck, TapRootPlugin } from '../../types/plugin.js';
import { loadMysql } from '../_shared/mysql-connection-lease.js';
import { isNonEmpty } from '../../core/text-presence.js';
import { proxyConnectionOptions } from './connection-options.js';
import type { ProxyTarget } from './connection-options.js';
import { resolveDbUser } from './db-user.js';
import { closeTeleportMysqlSessionProxies, ensureProxy } from './proxy-pool.js';
import { errorText } from '../../core/error-text.js';

type DoctorInput = Parameters<NonNullable<TapRootPlugin['doctor']>>[0];

const MISSING_FIELDS_DETAIL = 'missing target/dbUser/database in datasource+credentials';

function failedCheck(check: string, detail: string): DoctorCheck[] {
  return [{ check, status: DoctorStatus.Fail, detail, code: classifyExecutorDoctorCode(detail) }];
}

async function resolveDbUserForDoctor(input: DoctorInput): Promise<{ user: string; failureDetail: string }> {
  try {
    return { user: await resolveDbUser(input.datasource, input.credentials), failureDetail: MISSING_FIELDS_DETAIL };
  } catch (error) {
    return { user: '', failureDetail: errorText(error) };
  }
}

async function probeThroughProxy(proxyTarget: ProxyTarget, password: string | undefined): Promise<DoctorCheck[]> {
  const sessionId = `doctor-${process.pid}-${Date.now()}`;
  try {
    const proxy = await ensureProxy({ sessionId, ...proxyTarget });
    const mysql = await loadMysql();
    const conn = await mysql.createConnection(proxyConnectionOptions(proxy, proxyTarget, password));
    await conn.query('SELECT 1 AS ok');
    await conn.end();
    return [{ check: 'teleport-mysql query', status: DoctorStatus.Ok, detail: 'connection and read query succeeded' }];
  } catch (error) {
    return failedCheck('teleport-mysql query', errorText(error));
  } finally {
    await closeTeleportMysqlSessionProxies(sessionId);
  }
}

export async function checkTeleportMysql(input: DoctorInput): Promise<DoctorCheck[]> {
  const { target, database } = input.datasource.connection;
  const { user, failureDetail } = await resolveDbUserForDoctor(input);
  if (!isNonEmpty(target) || user === '' || !isNonEmpty(database)) {
    return failedCheck('teleport-mysql doctor', failureDetail);
  }
  return probeThroughProxy({ target, user, database }, input.credentials.password);
}
