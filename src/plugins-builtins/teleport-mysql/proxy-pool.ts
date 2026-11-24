import { registerCleanup } from '../../core/process-cleanup.js';
import { startProxy, stopProxy } from './proxy-process.js';
import type { ProxyIdentity, ProxyRuntime } from './proxy-process.js';

const proxiesByKey = new Map<string, Promise<ProxyRuntime>>();
const proxyKeysBySession = new Map<string, Set<string>>();
let cleanupRegistered = false;

function proxyKeyOf({ sessionId, target, user, database }: ProxyIdentity): string {
  return `${sessionId}|${target}|${user}|${database}`;
}

function indexSessionProxy(sessionId: string, key: string): void {
  const keys = proxyKeysBySession.get(sessionId) ?? new Set<string>();
  keys.add(key);
  proxyKeysBySession.set(sessionId, keys);
}

function unindexSessionProxy(sessionId: string, key: string): void {
  const keys = proxyKeysBySession.get(sessionId);
  if (keys === undefined) {
    return;
  }
  keys.delete(key);
  if (keys.size === 0) {
    proxyKeysBySession.delete(sessionId);
  }
}

function forgetProxy(sessionId: string, key: string, proxy: Promise<ProxyRuntime>): void {
  if (proxiesByKey.get(key) !== proxy) {
    return;
  }
  proxiesByKey.delete(key);
  unindexSessionProxy(sessionId, key);
}

async function startedProxyOf(starting: Promise<ProxyRuntime> | undefined): Promise<ProxyRuntime | undefined> {
  const [outcome] = await Promise.allSettled([starting]);
  return outcome?.status === 'fulfilled' ? outcome.value : undefined;
}

async function closeSessionProxy(sessionId: string, key: string): Promise<void> {
  const starting = proxiesByKey.get(key);
  proxiesByKey.delete(key);
  unindexSessionProxy(sessionId, key);
  const proxy = await startedProxyOf(starting);
  if (proxy !== undefined) {
    await stopProxy(proxy);
  }
}

export async function closeTeleportMysqlSessionProxies(sessionId: string): Promise<void> {
  const keys = proxyKeysBySession.get(sessionId);
  if (keys === undefined || keys.size === 0) {
    return;
  }
  const keysAtStart = [...keys];
  for (const key of keysAtStart) {
    await closeSessionProxy(sessionId, key);
  }
}

export async function closeAllTeleportMysqlProxies(): Promise<void> {
  const sessionIdsAtStart = [...proxyKeysBySession.keys()];
  for (const sessionId of sessionIdsAtStart) {
    await closeTeleportMysqlSessionProxies(sessionId);
  }
}

function registerCleanupOnce(): void {
  if (cleanupRegistered) {
    return;
  }
  cleanupRegistered = true;
  registerCleanup('teleport-mysql:all-proxies', closeAllTeleportMysqlProxies);
}

async function startIndexedProxy(identity: ProxyIdentity, key: string): Promise<ProxyRuntime> {
  const starting = startProxy(identity, () => {
    forgetProxy(identity.sessionId, key, starting);
  });
  proxiesByKey.set(key, starting);
  indexSessionProxy(identity.sessionId, key);
  try {
    return await starting;
  } catch (error) {
    forgetProxy(identity.sessionId, key, starting);
    throw error;
  }
}

export async function ensureProxy(identity: ProxyIdentity): Promise<ProxyRuntime> {
  registerCleanupOnce();
  const key = proxyKeyOf(identity);
  return proxiesByKey.get(key) ?? startIndexedProxy(identity, key);
}
