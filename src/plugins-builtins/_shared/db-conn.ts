import type { Connection } from 'mysql2/promise';
import type { QueryRequest } from '../../types/core.js';

export interface BaseConnConfig {
  host: string;
  port: number;
  user: string | undefined;
  password: string | undefined;
  database: string | undefined;
}

export function baseConnConfig(
  ds: QueryRequest['datasource'],
  creds: Record<string, string>,
  defaultPort: number,
): BaseConnConfig {
  return {
    host: ds.connection.host || '127.0.0.1',
    port: Number(ds.connection.port || defaultPort),
    user: creds.user,
    password: creds.password,
    database: ds.connection.database,
  };
}

export async function closeMysqlConnection(conn: Connection): Promise<void> {
  await conn.end().then(
    () => (conn as unknown as { connection?: { stream?: { unref?: () => void } } }).connection?.stream?.unref?.(),
    () => conn.destroy(),
  );
}
