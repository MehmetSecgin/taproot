import type mysql2 from 'mysql2/promise';
import type { Connection, ConnectionOptions, Pool } from 'mysql2/promise';
import { isUtcOffset } from '../../core/session-timezone.js';
import type { QueryRequest } from '../../types/plugin.js';
import { isNonEmpty } from '../../core/text-presence.js';
import { rawConnectionOf } from './raw-connection.js';

type MysqlModule = typeof mysql2;

type SessionSettings = {
  timeZone: string;
  readOnly: boolean;
  maxExecutionTimeMs: number;
};

export type MysqlLeaseRequest = {
  capability: QueryRequest['capability'];
  sessionId: string | undefined;
  signal: AbortSignal | undefined;
  timeoutMs: number | undefined;
};

type MysqlLease = {
  conn: Connection;
  release: () => Promise<void>;
};

const ER_UNKNOWN_SYSTEM_VARIABLE = 1193;
const ER_NOT_SUPPORTED_YET = 1235;
const UNSUPPORTED_SETTING_ERRNOS = new Set([ER_UNKNOWN_SYSTEM_VARIABLE, ER_NOT_SUPPORTED_YET]);
const POOL_CONNECTION_LIMIT = 4;
const POOL_MAX_IDLE_CONNECTIONS = 1;
const POOL_IDLE_TIMEOUT_MS = 300_000;
const NO_TIME_LIMIT_MS = 0;

const poolsBySession = new Map<string, Map<string, Pool>>();
const appliedSessionSettings = new WeakMap<object, SessionSettings>();
const FRESH_CONNECTION_SETTINGS: Partial<SessionSettings> = { readOnly: false };

async function closeMysqlConnection(conn: Connection): Promise<void> {
  try {
    await conn.end();
  } catch {
    conn.destroy();
    return;
  }
  rawConnectionOf(conn).stream.unref?.();
}

export async function loadMysql(): Promise<MysqlModule> {
  const mysqlModule = await import('mysql2/promise');
  return mysqlModule.default;
}

function sessionPoolFor(mysql: MysqlModule, sessionId: string, config: ConnectionOptions): Pool {
  const sessionPools = poolsBySession.get(sessionId) ?? new Map<string, Pool>();
  poolsBySession.set(sessionId, sessionPools);
  const key = JSON.stringify(config);
  let pool = sessionPools.get(key);
  if (pool === undefined) {
    pool = mysql.createPool({
      ...config,
      connectionLimit: POOL_CONNECTION_LIMIT,
      maxIdle: POOL_MAX_IDLE_CONNECTIONS,
      idleTimeout: POOL_IDLE_TIMEOUT_MS,
    });
    sessionPools.set(key, pool);
  }
  return pool;
}

function readTemporalsIn(timeZone: string): ConnectionOptions {
  return isUtcOffset(timeZone) ? { timezone: timeZone } : { dateStrings: true };
}

function ignoreUnsupportedSettingError(error: unknown): void {
  const errno = typeof error === 'object' && error !== null && 'errno' in error ? Number(error.errno) : Number.NaN;
  if (!UNSUPPORTED_SETTING_ERRNOS.has(errno)) {
    throw error;
  }
}

async function applySessionSettings(conn: Connection, wanted: SessionSettings): Promise<void> {
  const physical = rawConnectionOf(conn);
  const applied = appliedSessionSettings.get(physical) ?? FRESH_CONNECTION_SETTINGS;
  if (applied.timeZone !== wanted.timeZone) {
    await conn.query('SET time_zone = ?', [wanted.timeZone]);
  }
  if (applied.readOnly !== wanted.readOnly) {
    await conn.query('SET SESSION transaction_read_only = ?', [Number(wanted.readOnly)]).catch(ignoreUnsupportedSettingError);
  }
  if (applied.maxExecutionTimeMs !== wanted.maxExecutionTimeMs) {
    await conn.query('SET SESSION max_execution_time = ?', [wanted.maxExecutionTimeMs]).catch(ignoreUnsupportedSettingError);
  }
  appliedSessionSettings.set(physical, wanted);
}

async function applySessionSettingsOrDestroy(conn: Connection, wanted: SessionSettings): Promise<void> {
  let applied = false;
  try {
    await applySessionSettings(conn, wanted);
    applied = true;
  } finally {
    if (!applied) {
      conn.destroy();
    }
  }
}

async function checkOutConnection(config: ConnectionOptions, sessionId: string | undefined, readOnly: boolean): Promise<MysqlLease> {
  const mysql = await loadMysql();
  if (readOnly && isNonEmpty(sessionId)) {
    const poolConn = await sessionPoolFor(mysql, sessionId, config).getConnection();
    return {
      conn: poolConn,
      release: async () => {
        poolConn.release();
      },
    };
  }
  const conn = await mysql.createConnection(config);
  return { conn, release: async () => closeMysqlConnection(conn) };
}

export async function leaseMysqlConnection(config: ConnectionOptions, timeZone: string, lease: MysqlLeaseRequest): Promise<MysqlLease> {
  const readOnly = lease.capability === 'executeRead';
  const sessionConfig = { ...config, supportBigNumbers: true, ...readTemporalsIn(timeZone) };
  const checkedOut = await checkOutConnection(sessionConfig, lease.sessionId, readOnly);
  await applySessionSettingsOrDestroy(checkedOut.conn, { timeZone, readOnly, maxExecutionTimeMs: lease.timeoutMs ?? NO_TIME_LIMIT_MS });
  if (lease.signal?.aborted === true) {
    await checkedOut.release();
    lease.signal.throwIfAborted();
  }
  return checkedOut;
}

export async function closeMysqlSessionPools(sessionId: string): Promise<void> {
  const open = [...(poolsBySession.get(sessionId)?.values() ?? [])];
  poolsBySession.delete(sessionId);
  await Promise.allSettled(open.map(async (pool) => pool.end()));
}

export async function closeAllMysqlPools(): Promise<void> {
  await Promise.all([...poolsBySession.keys()].map(async (sessionId) => closeMysqlSessionPools(sessionId)));
}
