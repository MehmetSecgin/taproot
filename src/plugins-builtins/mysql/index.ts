import { DoctorStatus } from '../../types/core.js';
import type { DoctorCheck, QueryRequest, QueryResult, TapRootPlugin } from '../../types/core.js';
import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { classifyExecutorDoctorCode } from '../../core/error-classification.js';
import { queryTimeoutError } from '../../core/query-timeout.js';
import { DEFAULT_SESSION_TIME_ZONE } from '../../core/session-timezone.js';
import { enrichSqlSyntaxError } from '../../core/sql-hints.js';
import { nowIso } from '../../core/time.js';
import { baseConnConfig, leaseMysqlConnection, loadMysql } from '../_shared/db-conn.js';
import { str } from '../../core/strings.js';

function connConfig(ds: QueryRequest['datasource'], creds: Record<string, string>) {
  return {
    ...baseConnConfig(ds, creds, RUNTIME_CONSTANTS.defaultPorts.mysql),
    ssl: ds.connection.ssl ? {} : undefined,
    connectTimeout: RUNTIME_CONSTANTS.plugin.dbConnectTimeoutMs,
    timezone: 'Z',
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
    const startedAt = nowIso();
    const start = Date.now();
    const { conn, release } = await leaseMysqlConnection(
      connConfig(request.datasource, creds),
      request.sessionTimeZone || DEFAULT_SESSION_TIME_ZONE,
      Boolean(creds.__sessionId) && request.capability === 'executeRead',
    );
    try {
      const [rows, fields] = await conn.query(
        request.timeoutMs ? ({ sql: request.query, timeout: request.timeoutMs } as any) : request.query,
      );
      const normalizedRows = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
      const columns = Array.isArray(fields) ? fields.map((f: any) => str(f.name)) : Object.keys(normalizedRows[0] || {});
      return {
        datasource: request.datasource.name,
        plugin: 'mysql',
        capability: request.capability,
        query: { native: request.query },
        result: { columns, rows: normalizedRows },
        timings: {
          startedAt,
          endedAt: nowIso(),
          durationMs: Date.now() - start,
        },
        warnings: [],
        classification: 'success',
      };
    } catch (error) {
      const message = str((error as Error).message);
      if (request.timeoutMs && /timeout/i.test(message)) {
        (conn as any).destroy?.();
        throw queryTimeoutError(request.timeoutMs);
      }
      const enriched = enrichSqlSyntaxError(message, request.query);
      if (enriched !== message) throw new Error(enriched);
      throw error;
    } finally {
      await release();
    }
  },
};
