import { Client } from 'pg';
import type { DoctorCheck, QueryResult, TapRootPlugin } from '../../types/core.js';
import { classifyExecutorDoctorCode } from '../../core/error-classification.js';
import { queryTimeoutError } from '../../core/query-timeout.js';
import { nowIso } from '../../core/time.js';

function connConfig(ds: any, creds: Record<string, string>, timeoutMs?: number) {
  return {
    host: ds.connection.host || '127.0.0.1',
    port: Number(ds.connection.port || 5432),
    user: creds.user,
    password: creds.password,
    database: ds.connection.database,
    ssl: ds.connection.ssl ? { rejectUnauthorized: false } : undefined,
    statement_timeout: timeoutMs,
    query_timeout: timeoutMs,
  };
}

export const postgresPlugin: TapRootPlugin = {
  manifest: {
    name: 'postgres',
    version: '0.1.0',
    kind: 'executor',
    capabilities: ['doctor', 'executeRead'],
    accessMethods: ['native', 'qa-portforward'],
    priority: 100,
  },

  async doctor(input): Promise<DoctorCheck[]> {
    const client = new Client(connConfig(input.datasource, input.credentials));
    try {
      await client.connect();
      await client.query('SELECT 1 AS ok');
      return [{ check: 'postgres connect', status: 'ok', detail: 'connection and read query succeeded' }];
    } catch (error) {
      const detail = (error as Error).message;
      return [{ check: 'postgres connect', status: 'fail', detail, code: classifyExecutorDoctorCode(detail) }];
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
