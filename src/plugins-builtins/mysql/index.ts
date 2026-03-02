import mysql from 'mysql2/promise';
import type { DoctorCheck, QueryRequest, QueryResult, TelequeryPlugin } from '../../types/core.js';
import { nowIso } from '../../core/time.js';

function connConfig(ds: QueryRequest['datasource'], creds: Record<string, string>) {
  return {
    host: ds.connection.host || '127.0.0.1',
    port: Number(ds.connection.port || 3306),
    user: creds.user,
    password: creds.password,
    database: ds.connection.database,
    ssl: ds.connection.ssl ? {} : undefined,
  };
}

export const mysqlPlugin: TelequeryPlugin = {
  manifest: {
    name: 'mysql',
    version: '0.1.0',
    kind: 'executor',
    capabilities: ['doctor', 'executeRead'],
    accessMethods: ['native', 'qa-portforward'],
    priority: 100,
  },

  async doctor(input): Promise<DoctorCheck[]> {
    try {
      const conn = await mysql.createConnection(connConfig(input.datasource as any, input.credentials));
      await conn.query('SELECT 1 AS ok');
      await conn.end();
      return [{ check: 'mysql connect', status: 'ok', detail: 'connection and read query succeeded' }];
    } catch (error) {
      return [{ check: 'mysql connect', status: 'fail', detail: (error as Error).message }];
    }
  },

  async execute(request, creds): Promise<QueryResult> {
    const startedAt = nowIso();
    const start = Date.now();
    const conn = await mysql.createConnection(connConfig(request.datasource, creds));
    const [rows, fields] = await conn.query(request.query);
    await conn.end();
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
  },
};
