import type { ConnectionOptions } from 'mysql2/promise';
import { DoctorStatus } from '../../types/plugin.js';
import type { DoctorCheck, QueryRequest, QueryResult, TapRootPlugin } from '../../types/plugin.js';
import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { classifyExecutorDoctorCode } from '../../core/executor-errors.js';
import { DEFAULT_SESSION_TIME_ZONE } from '../../core/session-timezone.js';
import { closeAllMysqlPools, closeMysqlSessionPools, loadMysql } from '../_shared/mysql-connection-lease.js';
import { connectionHost, connectionPort } from '../_shared/connection-endpoint.js';
import { errorMessage } from '../_shared/error-message.js';
import { executeMysqlQuery } from '../_shared/execute-mysql-query.js';
import { sessionIdOf } from '../../core/session-credentials.js';

function mysqlConnectionOptions(datasource: QueryRequest['datasource'], credentials: Record<string, string>): ConnectionOptions {
  const { connection } = datasource;
  return {
    host: connectionHost(connection),
    port: connectionPort(connection, RUNTIME_CONSTANTS.defaultPorts.mysql),
    user: credentials.user,
    password: credentials.password,
    database: connection.database,
    ssl: connection.ssl === true ? {} : undefined,
    connectTimeout: RUNTIME_CONSTANTS.plugin.dbConnectTimeoutMs,
  };
}

async function probeConnection(input: Parameters<NonNullable<TapRootPlugin['doctor']>>[0]): Promise<DoctorCheck[]> {
  try {
    const mysql = await loadMysql();
    const conn = await mysql.createConnection(mysqlConnectionOptions(input.datasource, input.credentials));
    await conn.query('SET time_zone = ?', [DEFAULT_SESSION_TIME_ZONE]);
    await conn.query('SELECT 1 AS ok');
    await conn.end();
    return [{ check: 'mysql connect', status: DoctorStatus.Ok, detail: 'connection and read query succeeded' }];
  } catch (error) {
    const detail = errorMessage(error);
    return [{ check: 'mysql connect', status: DoctorStatus.Fail, detail, code: classifyExecutorDoctorCode(detail) }];
  }
}

export const mysqlPlugin: TapRootPlugin = {
  manifest: {
    name: 'mysql',
    capabilities: ['doctor', 'executeRead'],
  },

  doctor: probeConnection,

  async execute(request, creds): Promise<QueryResult> {
    return executeMysqlQuery({
      plugin: 'mysql',
      request,
      config: mysqlConnectionOptions(request.datasource, creds),
      sessionId: sessionIdOf(creds),
    });
  },

  closeSession: closeMysqlSessionPools,
  close: closeAllMysqlPools,
};
