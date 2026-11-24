import type { Connection } from 'mysql2/promise';
import type { QueryResult } from '../../types/plugin.js';
import { rawConnectionOf } from './raw-connection.js';

export type RowStreamOptions = {
  timeoutMs: number | undefined;
  maxRows: number | undefined;
  signal: AbortSignal | undefined;
};

export function destroyConnectionAndSocket(conn: Connection): void {
  conn.destroy();
  rawConnectionOf(conn).stream.destroy();
}

async function streamRows(conn: Connection, sql: string, { timeoutMs, maxRows }: RowStreamOptions): Promise<QueryResult['result']> {
  const raw = rawConnectionOf(conn);
  return new Promise((resolve, reject) => {
    let columns: string[] = [];
    const rows: unknown[][] = [];
    let settled = false;
    const settle = (result: QueryResult['result']): void => {
      settled = true;
      resolve(result);
    };
    raw.query({ sql, rowsAsArray: true, timeout: timeoutMs })
      .on('fields', (fields) => {
        if (Array.isArray(fields)) {
          columns = fields.map((field) => field.name);
        }
      })
      .on('result', (row) => {
        if (settled || !Array.isArray(row)) {
          return;
        }
        if (rows.length === maxRows) {
          destroyConnectionAndSocket(conn);
          settle({ columns, rows, truncated: true });
          return;
        }
        rows.push(row);
      })
      .on('error', (error) => {
        if (!settled) {
          reject(error);
        }
      })
      .on('end', () => {
        if (!settled) {
          settle({ columns, rows });
        }
      });
  });
}

export async function streamRowsUntilAborted(conn: Connection, sql: string, options: RowStreamOptions): Promise<QueryResult['result']> {
  const abort = (): void => {
    destroyConnectionAndSocket(conn);
  };
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    return await streamRows(conn, sql, options);
  } finally {
    options.signal?.removeEventListener('abort', abort);
  }
}
