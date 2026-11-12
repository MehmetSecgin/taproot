import { DoctorStatus } from '../../types/core.js';
import type { DoctorCheck, QueryRequest, QueryResult, TapRootPlugin } from '../../types/core.js';
import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { classifyExecutorDoctorCode } from '../../core/error-classification.js';
import { DEFAULT_SESSION_TIME_ZONE } from '../../core/session-timezone.js';
import { baseConnConfig, executeMysqlQuery, loadMysql } from '../_shared/db-conn.js';

function connConfig(ds: QueryRequest['datasource'], creds: Record<string, string>) {
  return {
    ...baseConnConfig(ds, creds, RUNTIME_CONSTANTS.defaultPorts.mysql),
    ssl: ds.connection.ssl ? {} : undefined,
    connectTimeout: RUNTIME_CONSTANTS.plugin.dbConnectTimeoutMs,
  };
}

export const mysqlPlugin: TapRootPlugin = {
  manifest: {
    name: 'mysql',
    kind: 'executor',
    capabilities: ['doctor', 'executeRead'],
    priority: 100,
  },

  async doctor(input): Promise<DoctorCheck[]> {
    try {
      const conn = await (await loadMysql()).createConnection(connConfig(input.datasource, input.credentials));
      await conn.query('SET time_zone = ?', [DEFAULT_SESSION_TIME_ZONE]);
      await conn.query('SELECT 1 AS ok');
      await conn.end();
      return [{ check: 'mysql connect', status: DoctorStatus.Ok, detail: 'connection and read query succeeded' }];
    } catch (error) {
      const detail = (error as Error).message;
      return [{ check: 'mysql connect', status: DoctorStatus.Fail, detail, code: classifyExecutorDoctorCode(detail) }];
    }
  },

  async execute(request, creds): Promise<QueryResult> {
    return executeMysqlQuery('mysql', request, connConfig(request.datasource, creds), creds.__sessionId);
  },
};
