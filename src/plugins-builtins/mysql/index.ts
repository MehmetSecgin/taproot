import mysql from 'mysql2/promise';
import { AccessMethod } from '../../types/core.js';
import type { DoctorCheck, QueryRequest, QueryResult, TapRootPlugin } from '../../types/core.js';
import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { classifyExecutorDoctorCode } from '../../core/error-classification.js';
import { queryTimeoutError } from '../../core/query-timeout.js';
import { nowIso } from '../../core/time.js';
import { baseConnConfig } from '../_shared/db-conn.js';

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
    version: '0.1.0',
    kind: 'executor',
    capabilities: ['doctor', 'executeRead'],
    accessMethods: [AccessMethod.Native, AccessMethod.QaPortforward],
    priority: 100,
  },

  async doctor(input): Promise<DoctorCheck[]> {
    try {
      const conn = await mysql.createConnection(connConfig(input.datasource, input.credentials));
      await conn.query('SELECT 1 AS ok');
      await conn.end();
      return [{ check: 'mysql connect', status: 'ok', detail: 'connection and read query succeeded' }];
    } catch (error) {
      const detail = (error as Error).message;
      return [{ check: 'mysql connect', status: 'fail', detail, code: classifyExecutorDoctorCode(detail) }];
    }
  },

  async execute(request, creds): Promise<QueryResult> {
    const startedAt = nowIso();
    const start = Date.now();
    const conn = await mysql.createConnection(connConfig(request.datasource, creds));
    try {
      const [rows, fields] = await conn.query(
        request.timeoutMs ? ({ sql: request.query, timeout: request.timeoutMs } as any) : request.query,
      );
      const normalizedRows = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
      const columns = Array.isArray(fields) ? fields.map((f: any) => String(f.name || '')) : Object.keys(normalizedRows[0] || {});
      return {
        runId: '',
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
      const message = String((error as Error).message || '');
      if (request.timeoutMs && /timeout/i.test(message)) {
        (conn as any).destroy?.();
        throw queryTimeoutError(request.timeoutMs);
      }
      throw error;
    } finally {
      await conn.end().catch(() => {
        (conn as any).destroy?.();
      });
    }
  },
};
