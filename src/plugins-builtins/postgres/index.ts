import { Client } from 'pg';
import type { DoctorCheck, QueryResult, TelequeryPlugin } from '../../types/core.js';
import { nowIso } from '../../core/time.js';

function connConfig(ds: any, creds: Record<string, string>) {
  return {
    host: ds.connection.host || creds.host || '127.0.0.1',
    port: Number(ds.connection.port || creds.port || 5432),
    user: creds.user,
    password: creds.password,
    database: ds.connection.database || creds.database,
    ssl: ds.connection.ssl ? { rejectUnauthorized: false } : undefined,
  };
}

export const postgresPlugin: TelequeryPlugin = {
  manifest: {
    name: 'postgres',
    version: '0.1.0',
    kind: 'executor',
    capabilities: ['doctor', 'executeRead'],
    priority: 100,
  },

  async doctor(input): Promise<DoctorCheck[]> {
    const client = new Client(connConfig(input.datasource, input.credentials));
    try {
      await client.connect();
      await client.query('SELECT 1 AS ok');
      return [{ check: 'postgres connect', status: 'ok', detail: 'connection and read query succeeded' }];
    } catch (error) {
      return [{ check: 'postgres connect', status: 'fail', detail: (error as Error).message }];
    } finally {
      await client.end().catch(() => {});
    }
  },

  async execute(request, creds): Promise<QueryResult> {
    const startedAt = nowIso();
    const start = Date.now();
    const client = new Client(connConfig(request.datasource, creds));
    await client.connect();
    const res = await client.query(request.query);
    await client.end();
    return {
      runId: '',
      datasource: request.datasource.name,
      plugin: 'postgres',
      capability: request.capability,
      query: { native: request.query },
      result: { columns: res.fields.map((f) => f.name), rows: res.rows as Array<Record<string, unknown>> },
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
