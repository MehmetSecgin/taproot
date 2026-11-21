import type { AppContext } from '../../core/app.js';
import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { deriveQueryTarget, executeQuery, silentQueryReport } from '../../core/execute-query.js';
import type { QueryExecutionRequest } from '../../core/execute-query.js';
import { parseTimeoutMs, queryTimeoutError } from '../../core/query-timeout.js';
import { queryDatasourceResolver } from '../../core/resolve-query-datasource.js';
import type { DatasourceProfile } from '../../types/core.js';
import { RpcMethod } from '../types.js';
import type { SessionRegistry } from '../session-registry.js';
import type { DaemonMethod, Handler } from './types.js';

export type QueryRequestShaper = (request: QueryExecutionRequest) => QueryExecutionRequest;

export interface QueryMethodOptions {
  shapeRequest?: QueryRequestShaper;
}

interface SessionLease {
  sessionId: string;
  release(): void;
}

const resolveFromStores = queryDatasourceResolver(undefined);

function completedRequest(params: Record<string, unknown>, ctx: AppContext): QueryExecutionRequest {
  const asSent = params as unknown as QueryExecutionRequest;
  const { env, namespace, service } = deriveQueryTarget(ctx, asSent);
  const timeoutDefault = ctx.runtimeConfigStore.queryTimeoutMs() ?? RUNTIME_CONSTANTS.query.defaultTimeoutMs;
  return { ...asSent, env, namespace, service, timeoutMs: parseTimeoutMs(params.timeoutMs, timeoutDefault) };
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

function queryHandler(shapeRequest: QueryRequestShaper): Handler {
  return async ({ req, base, deps, clientGone }) => {
    const { ctx, sessions, queryLimiter } = deps;
    const request = shapeRequest(completedRequest(req.params, ctx));
    const timeoutController = new AbortController();
    const timeoutTimer = setTimeout(() => timeoutController.abort(queryTimeoutError(request.timeoutMs)), request.timeoutMs);
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
        resolveDatasource: async (resolveRequest, resolveDeps) => {
          const resolved = await resolveFromStores(resolveRequest, resolveDeps);
          await deps.admitDatasource(resolved.datasource, resolveRequest.timeoutMs);
          return resolved;
        },
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
}

export function queryMethod(options: QueryMethodOptions = {}): DaemonMethod {
  return {
    name: RpcMethod.QueryExecute,
    handle: queryHandler(options.shapeRequest ?? ((request) => request)),
  };
}
