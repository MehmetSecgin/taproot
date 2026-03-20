import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import mysql from 'mysql2/promise';
import { registerCleanup } from '../../core/cleanup.js';
import { nowIso } from '../../core/time.js';
import type { QueryResult, TapRootPlugin } from '../../types/core.js';

type ProxyRuntime = {
  key: string;
  sessionId: string;
  target: string;
  dbUser: string;
  dbName: string;
  port: number;
  process: ChildProcess;
  cleanupRegistered: boolean;
};

const proxiesByKey = new Map<string, ProxyRuntime>();
const proxyKeyBySession = new Map<string, Set<string>>();
let globalCleanupRegistered = false;

function proxyKey(sessionId: string, target: string, dbUser: string, dbName: string): string {
  return `${sessionId}|${target}|${dbUser}|${dbName}`;
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
  throw new Error(`CONNECTIVITY: timed out waiting for teleport db proxy on ${host}:${port}`);
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

async function ensureProxy(sessionId: string, target: string, dbUser: string, dbName: string): Promise<ProxyRuntime> {
  ensureGlobalCleanup();
  const key = proxyKey(sessionId, target, dbUser, dbName);
  const existing = proxiesByKey.get(key);
  if (existing && !existing.process.killed) return existing;

  const port = await getFreePort();
  const args = ['proxy', 'db', '--tunnel', '--port', String(port), '--db-user', dbUser, '--db-name', dbName, target];
  const proc = spawn('tsh', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  let spawnError = '';
  proc.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  proc.stdout.on('data', () => {
    // ignore
  });
  proc.once('error', (error) => {
    spawnError = String((error as Error)?.message || error || '');
  });

  const runtime: ProxyRuntime = {
    key,
    sessionId,
    target,
    dbUser,
    dbName,
    port,
    process: proc,
    cleanupRegistered: true,
  };
  proxiesByKey.set(key, runtime);
  markSessionProxy(sessionId, key);

  try {
    await waitForTcpReady('127.0.0.1', port, 10000, () => (spawnError ? `CONNECTIVITY: teleport proxy path unavailable; ${spawnError}` : ''));
    return runtime;
  } catch (error) {
    await stopProxy(runtime);
    proxiesByKey.delete(key);
    removeSessionProxy(sessionId, key);
    if (spawnError) throw new Error(`CONNECTIVITY: teleport proxy path unavailable; ${spawnError}`);
    const detail = stderr.trim();
    if (detail) throw new Error(`CONNECTIVITY: teleport proxy path unavailable; ${detail}`);
    throw error;
  }
}

export const teleportMysqlPlugin: TapRootPlugin = {
  manifest: {
    name: 'teleport-mysql',
    version: '0.1.0',
    kind: 'executor',
    capabilities: ['doctor', 'executeRead'],
    accessMethods: ['tsh'],
    priority: 100,
  },

  async doctor(input) {
    const target = input.datasource.connection.target;
    const dbUser = input.credentials.dbUser || input.credentials.user;
    const dbName = input.datasource.connection.database;
    if (!target || !dbUser || !dbName) {
      return [{ check: 'teleport-mysql doctor', status: 'fail', detail: 'missing target/dbUser/database in datasource+credentials' }];
    }
    const sessionId = `doctor-${process.pid}-${Date.now()}`;
    try {
      const proxy = await ensureProxy(sessionId, String(target), String(dbUser), String(dbName));
      const conn = await mysql.createConnection({
        host: '127.0.0.1',
        port: proxy.port,
        user: String(dbUser),
        password: input.credentials.password,
        database: String(dbName),
      });
      await conn.query('SELECT 1 AS ok');
      await conn.end();
      return [{ check: 'teleport-mysql query', status: 'ok', detail: 'connection and read query succeeded' }];
    } catch (error) {
      return [{ check: 'teleport-mysql query', status: 'fail', detail: (error as Error).message }];
    } finally {
      await closeTeleportMysqlSessionProxies(sessionId);
    }
  },

  async execute(request, creds): Promise<QueryResult> {
    const startedAt = nowIso();
    const start = Date.now();
    const target = request.datasource.connection.target;
    const dbUser = creds.dbUser || creds.user;
    const dbName = request.datasource.connection.database;
    const sessionId = String(creds.__sessionId || '').trim();
    if (!target || !dbUser || !dbName) {
      throw new Error('teleport-mysql requires target, dbUser/user, and database');
    }

    const warnings: string[] = [];
    const effectiveSessionId = sessionId || `direct-${process.pid}-${Date.now()}`;
    const shouldCleanup = !sessionId;
    try {
      const proxy = await ensureProxy(effectiveSessionId, String(target), String(dbUser), String(dbName));
      const conn = await mysql.createConnection({
        host: '127.0.0.1',
        port: proxy.port,
        user: String(dbUser),
        password: creds.password,
        database: String(dbName),
      });
      const [rows, fields] = await conn.query(request.query);
      await conn.end();
      const normalizedRows = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
      const columns = Array.isArray(fields) ? fields.map((f: any) => String(f.name || '')) : Object.keys(normalizedRows[0] || {});
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
    } catch (proxyError) {
      throw new Error(`CONNECTIVITY: teleport proxy path unavailable; ${String((proxyError as Error).message || proxyError)}`);
    } finally {
      if (shouldCleanup) {
        await closeTeleportMysqlSessionProxies(effectiveSessionId);
      }
    }
  },
};
