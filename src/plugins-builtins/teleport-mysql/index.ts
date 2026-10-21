import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { registerCleanup } from '../../core/cleanup.js';
import { leaseMysqlConnection, loadMysql } from '../_shared/db-conn.js';
import { classifyExecutorDoctorCode, connectivity } from '../../core/error-classification.js';
import { queryTimeoutError } from '../../core/query-timeout.js';
import { DEFAULT_SESSION_TIME_ZONE } from '../../core/session-timezone.js';
import { enrichSqlSyntaxError } from '../../core/sql-hints.js';
import { nowIso } from '../../core/time.js';
import { fetchTshDatabases, tshDbAllowedUsers, tshDbName } from '../../core/discover-datasources.js';
import { AccessMethod, DoctorStatus } from '../../types/core.js';
import type { DatasourceProfile, QueryResult, TapRootPlugin } from '../../types/core.js';
import { str } from '../../core/strings.js';

type ProxyRuntime = {
  key: string;
  sessionId: string;
  target: string;
  user: string;
  database: string;
  port: number;
  process: ChildProcess;
  cleanupRegistered: boolean;
};

const proxiesByKey = new Map<string, ProxyRuntime>();
const proxyKeyBySession = new Map<string, Set<string>>();
const allowedUsersByTarget = new Map<string, string[]>();
let globalCleanupRegistered = false;

function proxyKey(sessionId: string, target: string, user: string, database: string): string {
  return `${sessionId}|${target}|${user}|${database}`;
}

function tshAllowedUsers(target: string): string[] {
  if (!allowedUsersByTarget.has(target)) {
    for (const db of fetchTshDatabases().databases) allowedUsersByTarget.set(tshDbName(db), tshDbAllowedUsers(db));
  }
  return allowedUsersByTarget.get(target) || [];
}

function resolveDbUser(ds: DatasourceProfile, creds: Record<string, string>): string {
  const hints = ds.resolverHints || {};
  const explicit = str(creds.dbUser || creds.user || hints.dbUser || hints.user).trim();
  const target = str(ds.connection.target).trim();
  if (explicit || !target) return explicit;
  const users = tshAllowedUsers(target);
  if (users.length > 1) {
    throw new Error(
      `teleport-mysql found several allowed db users for '${target}' in 'tsh db ls': ${users.join(', ')}. ` +
        `Pick one with 'taproot creds set --ref ${ds.credentialRef} --db-user <user>' ` +
        `or 'taproot datasource add --name ${ds.name} ... --hint dbUser=<user>'.`,
    );
  }
  return users[0] || '';
}

function ensureGlobalCleanup(): void {
  if (globalCleanupRegistered) return;
  globalCleanupRegistered = true;
  registerCleanup('teleport-mysql:all-proxies', async () => {
    await closeAllTeleportMysqlProxies();
  });
}

function markSessionProxy(sessionId: string, key: string): void {
  const set = proxyKeyBySession.get(sessionId) || new Set<string>();
  set.add(key);
  proxyKeyBySession.set(sessionId, set);
}

function removeSessionProxy(sessionId: string, key: string): void {
  const set = proxyKeyBySession.get(sessionId);
  if (!set) return;
  set.delete(key);
  if (!set.size) proxyKeyBySession.delete(sessionId);
}

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        server.close(() => reject(new Error('Failed to resolve free local port')));
        return;
      }
      const port = addr.port;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
    server.on('error', reject);
  });
}

async function waitForTcpReady(host: string, port: number, timeoutMs: number, shouldAbort?: () => string): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const abortReason = shouldAbort?.();
    if (abortReason) throw new Error(abortReason);
    const ok = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host, port });
      let settled = false;
      const finish = (value: boolean) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.setTimeout(300, () => finish(false));
    });
    if (ok) return;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw connectivity(`timed out waiting for teleport db proxy on ${host}:${port}`);
}

async function stopProxy(proxy: ProxyRuntime): Promise<void> {
  if (proxy.cleanupRegistered) {
    proxy.cleanupRegistered = false;
  }
  try {
    if (!proxy.process.killed) {
      proxy.process.kill('SIGTERM');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          try {
            proxy.process.kill('SIGKILL');
          } catch {
            // ignore
          }
          resolve();
        }, 800);
        proxy.process.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  } catch {
    // best effort
  }
}

export async function closeTeleportMysqlSessionProxies(sessionId: string): Promise<void> {
  const keys = proxyKeyBySession.get(sessionId);
  if (!keys || !keys.size) return;
  for (const key of [...keys]) {
    const proxy = proxiesByKey.get(key);
    if (!proxy) continue;
    await stopProxy(proxy);
    proxiesByKey.delete(key);
    removeSessionProxy(sessionId, key);
  }
}

export async function closeAllTeleportMysqlProxies(): Promise<void> {
  for (const proxy of [...proxiesByKey.values()]) {
    await stopProxy(proxy);
  }
  proxiesByKey.clear();
  proxyKeyBySession.clear();
}

async function ensureProxy(sessionId: string, target: string, user: string, database: string): Promise<ProxyRuntime> {
  ensureGlobalCleanup();
  const key = proxyKey(sessionId, target, user, database);
  const existing = proxiesByKey.get(key);
  if (existing && !existing.process.killed) return existing;

  const port = await getFreePort();
  const args = ['proxy', 'db', '--tunnel', '--port', String(port), '--db-user', user, '--db-name', database, target];
  const proc = spawn('tsh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  type ExitInfo = { code: number | null; signal: NodeJS.Signals | null };
  let stderr = '';
  let spawnError = '';
  const exitState: { value: ExitInfo | null } = { value: null };
  proc.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  proc.stdout.on('data', () => {
    // ignore
  });
  proc.once('error', (error) => {
    spawnError = str((error as Error)?.message || error);
  });
  proc.once('exit', (code, signal) => {
    exitState.value = { code, signal };
  });

  const runtime: ProxyRuntime = {
    key,
    sessionId,
    target,
    user,
    database,
    port,
    process: proc,
    cleanupRegistered: true,
  };
  proxiesByKey.set(key, runtime);
  markSessionProxy(sessionId, key);

  const abortReason = (): string => {
    if (spawnError) return `CONNECTIVITY: teleport proxy path unavailable; ${spawnError}`;
    const exit = exitState.value;
    if (exit) {
      const detail = stderr.trim() || `tsh proxy db exited code=${exit.code} signal=${exit.signal ?? 'none'}`;
      return `CONNECTIVITY: teleport proxy path unavailable; ${detail}`;
    }
    return '';
  };

  try {
    await waitForTcpReady('127.0.0.1', port, 10000, abortReason);
    return runtime;
  } catch (error) {
    await stopProxy(runtime);
    proxiesByKey.delete(key);
    removeSessionProxy(sessionId, key);
    if (spawnError) throw connectivity(`teleport proxy path unavailable; ${spawnError}`);
    const exit = exitState.value;
    if (exit) {
      const detail = stderr.trim() || `tsh proxy db exited code=${exit.code} signal=${exit.signal ?? 'none'}`;
      throw connectivity(`teleport proxy path unavailable; ${detail}`);
    }
    const detail = stderr.trim();
    if (detail) throw connectivity(`teleport proxy path unavailable; ${detail}`);
    throw error;
  }
}

export const teleportMysqlPlugin: TapRootPlugin = {
  manifest: {
    name: 'teleport-mysql',
    version: '0.1.0',
    kind: 'executor',
    capabilities: ['doctor', 'executeRead'],
    accessMethods: [AccessMethod.Tsh],
    priority: 100,
  },

  async doctor(input) {
    const target = input.datasource.connection.target;
    const database = input.datasource.connection.database;
    let user = '';
    let detail = 'missing target/dbUser/database in datasource+credentials';
    try {
      user = resolveDbUser(input.datasource, input.credentials);
    } catch (error) {
      detail = (error as Error).message;
    }
    if (!target || !user || !database) {
      return [{ check: 'teleport-mysql doctor', status: DoctorStatus.Fail, detail, code: classifyExecutorDoctorCode(detail) }];
    }
    const sessionId = `doctor-${process.pid}-${Date.now()}`;
    try {
      const proxy = await ensureProxy(sessionId, String(target), String(user), String(database));
      const conn = await (await loadMysql()).createConnection({
        host: '127.0.0.1',
        port: proxy.port,
        user: String(user),
        password: input.credentials.password,
        database: String(database),
      });
      await conn.query('SELECT 1 AS ok');
      await conn.end();
      return [{ check: 'teleport-mysql query', status: DoctorStatus.Ok, detail: 'connection and read query succeeded' }];
    } catch (error) {
      const detail = (error as Error).message;
      return [{ check: 'teleport-mysql query', status: DoctorStatus.Fail, detail, code: classifyExecutorDoctorCode(detail) }];
    } finally {
      await closeTeleportMysqlSessionProxies(sessionId);
    }
  },

  async execute(request, creds): Promise<QueryResult> {
    const startedAt = nowIso();
    const start = Date.now();
    const target = request.datasource.connection.target;
    const user = resolveDbUser(request.datasource, creds);
    const database = request.datasource.connection.database;
    const sessionId = str(creds.__sessionId).trim();
    if (!target || !user || !database) {
      const missing = [!target && 'target', !user && 'dbUser/user', !database && 'database'].filter(Boolean).join(', ');
      throw new Error(
        `teleport-mysql is missing ${missing} for datasource '${request.datasource.name}'. ` +
          `Set the db user with 'taproot creds set --ref ${request.datasource.credentialRef} --db-user <user>' ` +
          `or repair routing with 'taproot datasource resolve --env ${str(request.datasource.env)} --service ${str(request.datasource.service)}'.`,
      );
    }

    const warnings: string[] = [];
    const effectiveSessionId = sessionId || `direct-${process.pid}-${Date.now()}`;
    const shouldCleanup = !sessionId;
    let proxyReady = false;
    try {
      const proxy = await ensureProxy(effectiveSessionId, String(target), String(user), String(database));
      proxyReady = true;
      const { conn, release } = await leaseMysqlConnection(
        {
          host: '127.0.0.1',
          port: proxy.port,
          user: String(user),
          password: creds.password,
          database: String(database),
        },
        request.sessionTimeZone || DEFAULT_SESSION_TIME_ZONE,
        Boolean(sessionId) && request.capability === 'executeRead',
      );
      try {
        const [rows, fields] = await conn.query(
          request.timeoutMs ? ({ sql: request.query, timeout: request.timeoutMs } as any) : request.query,
        );
        const normalizedRows = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
        const columns = Array.isArray(fields) ? fields.map((f: any) => str(f.name)) : Object.keys(normalizedRows[0] || {});
        return {
          runId: '',
          datasource: request.datasource.name,
          plugin: 'teleport-mysql',
          capability: request.capability,
          query: { native: request.query },
          result: { columns, rows: normalizedRows },
          timings: { startedAt, endedAt: nowIso(), durationMs: Date.now() - start },
          warnings,
          classification: 'success',
        };
      } catch (error) {
        const message = str((error as Error).message);
        if (request.timeoutMs && /timeout/i.test(message)) {
          (conn as any).destroy?.();
          throw queryTimeoutError(request.timeoutMs);
        }
        const enriched = enrichSqlSyntaxError(message, request.query);
        if (enriched !== message) throw new Error(enriched);
        throw error;
      } finally {
        await release();
      }
    } catch (proxyError) {
      if (proxyReady || str((proxyError as Error).message).startsWith('QUERY_TIMEOUT:')) {
        throw proxyError;
      }
      throw connectivity(`teleport proxy path unavailable; ${String((proxyError as Error).message || proxyError)}`);
    } finally {
      if (shouldCleanup) {
        await closeTeleportMysqlSessionProxies(effectiveSessionId);
      }
    }
  },
};
