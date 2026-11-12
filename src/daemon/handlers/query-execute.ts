import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { executeQuery, silentQueryReport } from '../../core/execute-query.js';
import type { QueryExecutionRequest } from '../../core/execute-query.js';
import { parseTimeoutMs, queryTimeoutError } from '../../core/query-timeout.js';
import type { DatasourceProfile } from '../../types/core.js';
import type { SessionRegistry } from '../session-registry.js';
import type { Handler } from './types.js';

interface SessionLease {
  sessionId: string;
  release(): void;
}

function leaseSession(sessions: SessionRegistry, datasource: DatasourceProfile): SessionLease {
  const { sessionId } = sessions.open({
    datasourceName: datasource.name,
    env: datasource.env,
    namespace: datasource.namespace,
    service: datasource.service,
    kind: datasource.kind,
    connection: datasource.connection,
    connectors: datasource.connectors,
  });
  const leaseId = sessions.acquireLease(sessionId);
  const heartbeat = setInterval(() => sessions.heartbeatLease(sessionId, leaseId), RUNTIME_CONSTANTS.session.leaseHeartbeatIntervalMs);
  return {
    sessionId,
    release: () => {
      clearInterval(heartbeat);
      sessions.releaseLease(sessionId, leaseId);
    },
  };
}

export const handleQueryExecute: Handler = async ({ req, base, deps, clientGone }) => {
  const { ctx, sessions, queryLimiter } = deps;
  const timeoutDefault = ctx.runtimeConfigStore.queryTimeoutMs() ?? RUNTIME_CONSTANTS.query.defaultTimeoutMs;
  const timeoutMs = parseTimeoutMs(req.params.timeoutMs, timeoutDefault);
  const request = { ...(req.params as unknown as QueryExecutionRequest), timeoutMs, allowDiscovery: false };
  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => timeoutController.abort(queryTimeoutError(timeoutMs)), timeoutMs);
  const releaseGlobal = await queryLimiter.acquire({ signal: AbortSignal.any([clientGone, timeoutController.signal]) });
  let lease: SessionLease | undefined;
  try {
    const outcome = await executeQuery(request, {
      ctx,
      report: silentQueryReport,
      signal: clientGone,
      openSession: (datasource) => {
        lease = leaseSession(sessions, datasource);
        base.meta.sessionId = lease.sessionId;
        return lease.sessionId;
      },
      acquireQuerySlot: (signal) => queryLimiter.acquire({ signal }),
    });
    const meta = outcome.meta;
    if (meta.schemaContext) base.meta.schemaContext = meta.schemaContext;
    if (meta.phases) (base.meta as Record<string, unknown>).phases = meta.phases;
    if (meta.resolved) (base.meta as Record<string, unknown>).resolved = meta.resolved;
    if (meta.timings) (base.meta as Record<string, unknown>).timings = meta.timings;

    if (outcome.ok) {
      base.ok = true;
      base.data = outcome.data as unknown as Record<string, unknown>;
      return;
    }
    base.error = {
      code: outcome.code,
      message: outcome.message,
      details: outcome.details as Record<string, unknown> | undefined,
    };
  } finally {
    clearTimeout(timeoutTimer);
    lease?.release();
    releaseGlobal();
  }
};
