import type { Connection, ConnectionOptions, Pool } from 'mysql2/promise';
import { isUtcOffset } from '../../core/session-timezone.js';
import type { QueryRequest } from '../../types/core.js';

export interface BaseConnConfig {
  host: string;
  port: number;
  user: string | undefined;
  password: string | undefined;
  database: string | undefined;
}

const pools = new Map<string, Pool>();
const connectionTimeZones = new WeakMap<object, string>();
const READ_ONLY_UNENFORCED_ERRNOS = new Set([1193, 1235]);

export interface MysqlLeaseRequest {
  capability: QueryRequest['capability'];
  inSession: boolean;
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

async function closeMysqlConnection(conn: Connection): Promise<void> {
  await conn.end().then(
    () => (conn as unknown as { connection?: { stream?: { unref?: () => void } } }).connection?.stream?.unref?.(),
    () => conn.destroy(),
  );
}

export async function loadMysql() {
  return (await import('mysql2/promise')).default;
}

function poolFor(mysql: Awaited<ReturnType<typeof loadMysql>>, config: ConnectionOptions): Pool {
  const key = JSON.stringify(config);
  let pool = pools.get(key);
  if (!pool) {
    pool = mysql.createPool({ ...config, connectionLimit: 4, maxIdle: 1, idleTimeout: 5 * 60 * 1000 });
    pools.set(key, pool);
  }
  return pool;
}

function readTemporalsIn(timeZone: string): ConnectionOptions {
  return isUtcOffset(timeZone) ? { timezone: timeZone } : { dateStrings: true };
}

function ignoreUnenforcedReadOnly(error: { errno?: number }): void {
  if (!READ_ONLY_UNENFORCED_ERRNOS.has(Number(error.errno))) throw error;
}

async function prepareSession(conn: Connection, timeZone: string, readOnly: boolean): Promise<void> {
  await conn.query('SET time_zone = ?', [timeZone]);
  if (readOnly) await conn.query('SET SESSION transaction_read_only = 1').catch(ignoreUnenforcedReadOnly);
}

export async function leaseMysqlConnection(config: ConnectionOptions, timeZone: string, lease: MysqlLeaseRequest) {
  const readOnly = lease.capability === 'executeRead';
  const mysql = await loadMysql();
  const sessionConfig = { ...config, supportBigNumbers: true, ...readTemporalsIn(timeZone) };
  const poolConn = readOnly && lease.inSession ? await poolFor(mysql, sessionConfig).getConnection() : undefined;
  const conn = poolConn ?? (await mysql.createConnection(sessionConfig));
  const physical = (conn as unknown as { connection: object }).connection;
  if (connectionTimeZones.get(physical) !== timeZone) {
    try {
      await prepareSession(conn, timeZone, readOnly);
    } catch (error) {
      conn.destroy();
      throw error;
    }
    connectionTimeZones.set(physical, timeZone);
  }
  return { conn, release: async () => (poolConn ? poolConn.release() : closeMysqlConnection(conn)) };
}

export async function closeAllMysqlPools(): Promise<void> {
  const open = [...pools.values()];
  pools.clear();
  await Promise.all(open.map((pool) => pool.end().catch(() => undefined)));
}
