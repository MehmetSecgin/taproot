import type { QueryRequest, QueryResult } from '../../types/plugin.js';
import { executeMysqlQuery } from '../_shared/execute-mysql-query.js';
import { isNonEmpty } from '../../core/text-presence.js';
import { sessionIdOf } from '../../core/session-credentials.js';
import { proxyConnectionOptions } from './connection-options.js';
import type { ProxyTarget } from './connection-options.js';
import { resolveDbUser } from './db-user.js';
import { closeTeleportMysqlSessionProxies, ensureProxy } from './proxy-pool.js';
import { proxyUnavailableError } from './proxy-process.js';

const PASSTHROUGH_ERROR_PREFIX = /^(?:QUERY_TIMEOUT|MISSING_TOOL):/u;

function rethrowAsProxyUnavailable(error: Error): never {
  if (PASSTHROUGH_ERROR_PREFIX.test(error.message)) {
    throw error;
  }
  throw proxyUnavailableError(error.message === '' ? String(error) : error.message);
}

function missingFieldsError(request: QueryRequest, fields: Record<string, string | undefined>): Error {
  const missing = Object.entries(fields).filter(([, value]) => !isNonEmpty(value)).map(([name]) => name);
  const { datasource } = request;
  return new Error(
    `teleport-mysql is missing ${missing.join(', ')} for datasource '${datasource.name}'. ` +
      `Set the db user with 'taproot creds set --ref ${datasource.credentialRef} --db-user <user>' ` +
      `or repair routing with 'taproot datasource resolve --env ${datasource.env ?? ''} --service ${datasource.service ?? ''}'.`,
  );
}

async function executeThroughProxy(request: QueryRequest, proxyTarget: ProxyTarget, credentials: Record<string, string>): Promise<QueryResult> {
  const callerSessionId = (sessionIdOf(credentials) ?? '').trim();
  const proxyOwnerId = callerSessionId === '' ? `direct-${process.pid}-${Date.now()}` : callerSessionId;
  try {
    const proxy = await ensureProxy({ sessionId: proxyOwnerId, ...proxyTarget }).catch(rethrowAsProxyUnavailable);
    const config = proxyConnectionOptions(proxy, proxyTarget, credentials.password);
    return await executeMysqlQuery({ plugin: 'teleport-mysql', request, config, sessionId: callerSessionId });
  } finally {
    if (callerSessionId === '') {
      await closeTeleportMysqlSessionProxies(proxyOwnerId);
    }
  }
}

export async function executeTeleportMysql(request: QueryRequest, credentials: Record<string, string>): Promise<QueryResult> {
  const { target, database } = request.datasource.connection;
  const user = await resolveDbUser(request.datasource, credentials);
  if (!isNonEmpty(target) || user === '' || !isNonEmpty(database)) {
    throw missingFieldsError(request, { target, 'dbUser/user': user, database });
  }
  return executeThroughProxy(request, { target, user, database }, credentials);
}
