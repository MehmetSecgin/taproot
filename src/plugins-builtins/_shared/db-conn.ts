import type { Connection, ConnectionOptions, Pool } from 'mysql2/promise';
import { queryTimeoutError } from '../../core/query-timeout.js';
import { DEFAULT_SESSION_TIME_ZONE, isUtcOffset } from '../../core/session-timezone.js';
import { enrichResourceLimitError, enrichSqlSyntaxError } from '../../core/sql-hints.js';
import { str } from '../../core/strings.js';
import { nowIso } from '../../core/time.js';
import type { QueryRequest, QueryResult } from '../../types/core.js';

export interface BaseConnConfig {
  host: string;
  port: number;
  user: string | undefined;
  password: string | undefined;
  database: string | undefined;
}

interface SessionSettings {
  timeZone: string;
  readOnly: boolean;
  maxExecutionTimeMs: number;
}

const poolsBySession = new Map<string, Map<string, Pool>>();
const appliedSessionSettings = new WeakMap<object, SessionSettings>();
const NEW_SESSION_SETTINGS: Partial<SessionSettings> = { readOnly: false };
const UNSUPPORTED_SETTING_ERRNOS = new Set([1193, 1235]);

export interface MysqlLeaseRequest {
  capability: QueryRequest['capability'];
  sessionId: string | undefined;
  signal: AbortSignal | undefined;
  timeoutMs: number | undefined;
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

function poolFor(mysql: Awaited<ReturnType<typeof loadMysql>>, sessionId: string, config: ConnectionOptions): Pool {
  const sessionPools = poolsBySession.get(sessionId) ?? new Map<string, Pool>();
  poolsBySession.set(sessionId, sessionPools);
  const key = JSON.stringify(config);
  let pool = sessionPools.get(key);
  if (!pool) {
    pool = mysql.createPool({ ...config, connectionLimit: 4, maxIdle: 1, idleTimeout: 5 * 60 * 1000 });
    sessionPools.set(key, pool);
  }
  return pool;
}

function readTemporalsIn(timeZone: string): ConnectionOptions {
  return isUtcOffset(timeZone) ? { timezone: timeZone } : { dateStrings: true };
}

function ignoreUnsupportedSetting(error: { errno?: number }): void {
  if (!UNSUPPORTED_SETTING_ERRNOS.has(Number(error.errno))) throw error;
}

async function applySessionSettings(conn: Connection, wanted: SessionSettings): Promise<void> {
  const physical = (conn as unknown as { connection: object }).connection;
  const applied = appliedSessionSettings.get(physical) ?? NEW_SESSION_SETTINGS;
  if (applied.timeZone !== wanted.timeZone) await conn.query('SET time_zone = ?', [wanted.timeZone]);
  if (applied.readOnly !== wanted.readOnly) {
    await conn.query('SET SESSION transaction_read_only = ?', [Number(wanted.readOnly)]).catch(ignoreUnsupportedSetting);
  }
  if (applied.maxExecutionTimeMs !== wanted.maxExecutionTimeMs) {
    await conn.query('SET SESSION max_execution_time = ?', [wanted.maxExecutionTimeMs]).catch(ignoreUnsupportedSetting);
  }
  appliedSessionSettings.set(physical, wanted);
}

export async function leaseMysqlConnection(config: ConnectionOptions, timeZone: string, lease: MysqlLeaseRequest) {
  const readOnly = lease.capability === 'executeRead';
  const mysql = await loadMysql();
  const sessionConfig = { ...config, supportBigNumbers: true, ...readTemporalsIn(timeZone) };
  const poolConn = readOnly && lease.sessionId ? await poolFor(mysql, lease.sessionId, sessionConfig).getConnection() : undefined;
  const conn = poolConn ?? (await mysql.createConnection(sessionConfig));
  try {
    await applySessionSettings(conn, { timeZone, readOnly, maxExecutionTimeMs: lease.timeoutMs ?? 0 });
  } catch (error) {
    conn.destroy();
    throw error;
  }
  const release = async () => (poolConn ? poolConn.release() : closeMysqlConnection(conn));
  if (lease.signal?.aborted) {
    await release();
    throw lease.signal.reason;
  }
  return { conn, release };
}

async function queryRows(
  conn: Connection,
  sql: string,
  timeoutMs: number | undefined,
  signal: AbortSignal | undefined,
): Promise<QueryResult['result']> {
  const destroy = () => conn.destroy();
  signal?.addEventListener('abort', destroy, { once: true });
  try {
    const [rows, fields] = await conn.query({ sql, rowsAsArray: true, timeout: timeoutMs });
    return {
      columns: Array.isArray(fields) ? fields.map((field) => field.name) : [],
      rows: Array.isArray(rows) ? (rows as unknown[][]) : [],
    };
  } finally {
    signal?.removeEventListener('abort', destroy);
  }
}

export async function executeMysqlQuery(
  plugin: string,
  request: QueryRequest,
  config: ConnectionOptions,
  sessionId: string | undefined,
): Promise<QueryResult> {
  const startedAt = nowIso();
  const start = Date.now();
  const { conn, release } = await leaseMysqlConnection(config, request.sessionTimeZone || DEFAULT_SESSION_TIME_ZONE, {
    capability: request.capability,
    sessionId,
    signal: request.signal,
    timeoutMs: request.timeoutMs,
  });
  try {
    const result = await queryRows(conn, request.query, request.timeoutMs, request.signal);
    return {
      datasource: request.datasource.name,
      plugin,
      capability: request.capability,
      query: { native: request.query },
      result,
      timings: { startedAt, endedAt: nowIso(), durationMs: Date.now() - start },
      warnings: [],
      classification: 'success',
    };
  } catch (error) {
    const message = str((error as Error).message);
    if (request.timeoutMs && /timeout/i.test(message)) {
      conn.destroy();
      throw queryTimeoutError(request.timeoutMs);
    }
    const enriched = enrichSqlSyntaxError(enrichResourceLimitError(message), request.query);
    throw enriched === message ? error : new Error(enriched);
  } finally {
    await release();
  }
}

export async function closeMysqlSessionPools(sessionId: string): Promise<void> {
  const open = [...(poolsBySession.get(sessionId)?.values() ?? [])];
  poolsBySession.delete(sessionId);
  await Promise.all(open.map((pool) => pool.end().catch(() => undefined)));
}

export async function closeAllMysqlPools(): Promise<void> {
  await Promise.all([...poolsBySession.keys()].map(closeMysqlSessionPools));
}
