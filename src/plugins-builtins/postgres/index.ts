import { Client } from 'pg';
import { AccessMethod, DoctorStatus } from '../../types/core.js';
import type { DoctorCheck, QueryRequest, QueryResult, TapRootPlugin } from '../../types/core.js';
import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { classifyExecutorDoctorCode } from '../../core/error-classification.js';
import { queryTimeoutError } from '../../core/query-timeout.js';
import { nowIso } from '../../core/time.js';
import { baseConnConfig } from '../_shared/db-conn.js';

function connConfig(ds: QueryRequest['datasource'], creds: Record<string, string>, timeoutMs?: number) {
  return {
    ...baseConnConfig(ds, creds, RUNTIME_CONSTANTS.defaultPorts.postgres),
    ssl: ds.connection.ssl ? { rejectUnauthorized: false } : undefined,
    statement_timeout: timeoutMs,
    query_timeout: timeoutMs,
    connectionTimeoutMillis: RUNTIME_CONSTANTS.plugin.dbConnectTimeoutMs,
  };
}

export const postgresPlugin: TapRootPlugin = {
  manifest: {
    name: 'postgres',
    version: '0.1.0',
    kind: 'executor',
    capabilities: ['doctor', 'executeRead'],
    accessMethods: [AccessMethod.Native, AccessMethod.QaPortforward],
    priority: 100,
  },

  async doctor(input): Promise<DoctorCheck[]> {
    const client = new Client(connConfig(input.datasource, input.credentials));
    try {
      await client.connect();
      await client.query('SELECT 1 AS ok');
      return [{ check: 'postgres connect', status: DoctorStatus.Ok, detail: 'connection and read query succeeded' }];
    } catch (error) {
      const detail = (error as Error).message;
      return [{ check: 'postgres connect', status: DoctorStatus.Fail, detail, code: classifyExecutorDoctorCode(detail) }];
    } finally {
      await client.end().catch(() => {});
    }
  },

  async execute(request, creds): Promise<QueryResult> {
    const startedAt = nowIso();
    const start = Date.now();
    const client = new Client(connConfig(request.datasource, creds, request.timeoutMs));
    try {
      await client.connect();
      const res = await client.query(
        request.timeoutMs ? ({ text: request.query, query_timeout: request.timeoutMs } as any) : request.query,
      );
      return {
        runId: '',
        datasource: request.datasource.name,
        plugin: 'postgres',
        capability: request.capability,
        query: { native: request.query },
        result: { columns: res.fields.map((f: { name: string }) => f.name), rows: res.rows as Array<Record<string, unknown>> },
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
      if (request.timeoutMs && /(statement timeout|query timeout|query read timeout|timeout)/i.test(message)) {
        throw queryTimeoutError(request.timeoutMs);
      }
      throw error;
    } finally {
      await client.end().catch(() => {});
    }
  },
};
