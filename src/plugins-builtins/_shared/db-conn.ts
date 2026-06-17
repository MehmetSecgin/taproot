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
