import net from 'node:net';
import { spawn, type ChildProcess } from 'node:child_process';
import { registerCleanup } from '../../core/cleanup.js';
import { executeMysqlQuery, loadMysql } from '../_shared/db-conn.js';
import { classifyExecutorDoctorCode, connectivity, spawnErrorMessage } from '../../core/error-classification.js';
import { fetchTshDatabases, tshDbAllowedUsers, tshDbName } from '../../core/tsh-databases.js';
import { DoctorStatus } from '../../types/core.js';
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

const proxiesByKey = new Map<string, Promise<ProxyRuntime>>();
const proxyKeyBySession = new Map<string, Set<string>>();
const allowedUsersByTarget = new Map<string, string[]>();
let globalCleanupRegistered = false;

function proxyKey(sessionId: string, target: string, user: string, database: string): string {
  return `${sessionId}|${target}|${user}|${database}`;
}

async function tshAllowedUsers(target: string): Promise<string[]> {
  if (!allowedUsersByTarget.has(target)) {
    for (const db of (await fetchTshDatabases()).databases) allowedUsersByTarget.set(tshDbName(db), tshDbAllowedUsers(db));
  }
  return allowedUsersByTarget.get(target) || [];
}

async function resolveDbUser(ds: DatasourceProfile, creds: Record<string, string>): Promise<string> {
  const hints = ds.resolverHints || {};
  const explicit = str(creds.dbUser || creds.user || hints.dbUser || hints.user).trim();
  const target = str(ds.connection.target).trim();
  if (explicit || !target) return explicit;
  const users = await tshAllowedUsers(target);
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

function forgetProxy(sessionId: string, key: string, proxy: Promise<ProxyRuntime>): void {
  if (proxiesByKey.get(key) !== proxy) return;
  proxiesByKey.delete(key);
  removeSessionProxy(sessionId, key);
}

function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null;
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
    if (!proxy.process.killed && !hasExited(proxy.process)) {
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
    const starting = proxiesByKey.get(key);
    proxiesByKey.delete(key);
    removeSessionProxy(sessionId, key);
    const proxy = await starting?.catch(() => undefined);
    if (proxy) await stopProxy(proxy);
  }
}

export async function closeAllTeleportMysqlProxies(): Promise<void> {
  for (const sessionId of [...proxyKeyBySession.keys()]) await closeTeleportMysqlSessionProxies(sessionId);
}

async function ensureProxy(sessionId: string, target: string, user: string, database: string): Promise<ProxyRuntime> {
  ensureGlobalCleanup();
  const key = proxyKey(sessionId, target, user, database);
  const existing = proxiesByKey.get(key);
  if (existing) return await existing;
  const starting = startProxy(key, sessionId, target, user, database, () => forgetProxy(sessionId, key, starting));
  proxiesByKey.set(key, starting);
  markSessionProxy(sessionId, key);
  try {
    return await starting;
  } catch (error) {
    forgetProxy(sessionId, key, starting);
    throw error;
  }
}

async function startProxy(
  key: string,
  sessionId: string,
  target: string,
  user: string,
  database: string,
  onExit: () => void,
): Promise<ProxyRuntime> {
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
    spawnError = spawnErrorMessage(error);
  });
  proc.once('exit', (code, signal) => {
    exitState.value = { code, signal };
    onExit();
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

  const abortReason = (): string => {
    if (spawnError) return spawnError.startsWith('MISSING_TOOL:') ? spawnError : `CONNECTIVITY: teleport proxy path unavailable; ${spawnError}`;
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
    if (spawnError.startsWith('MISSING_TOOL:')) throw new Error(spawnError);
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

function proxyUnavailable(error: Error): never {
  if (/^(QUERY_TIMEOUT|MISSING_TOOL):/.test(str(error.message))) throw error;
  throw connectivity(`teleport proxy path unavailable; ${String(error.message || error)}`);
}

export const teleportMysqlPlugin: TapRootPlugin = {
  manifest: {
    name: 'teleport-mysql',
    capabilities: ['doctor', 'executeRead'],
  },

  async doctor(input) {
    const target = input.datasource.connection.target;
    const database = input.datasource.connection.database;
    let user = '';
    let detail = 'missing target/dbUser/database in datasource+credentials';
    try {
      user = await resolveDbUser(input.datasource, input.credentials);
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
    const target = request.datasource.connection.target;
    const user = await resolveDbUser(request.datasource, creds);
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

    const proxySessionId = sessionId || `direct-${process.pid}-${Date.now()}`;
    try {
      const proxy = await ensureProxy(proxySessionId, String(target), String(user), String(database)).catch(proxyUnavailable);
      const config = { host: '127.0.0.1', port: proxy.port, user: String(user), password: creds.password, database: String(database) };
      return await executeMysqlQuery('teleport-mysql', request, config, sessionId);
    } finally {
      if (!sessionId) await closeTeleportMysqlSessionProxies(proxySessionId);
    }
  },
};
