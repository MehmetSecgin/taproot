import { executeQuery, silentQueryReport } from '../../core/execute-query.js';
import type { QueryDeps, QueryExecutionRequest, QueryOutcome } from '../../core/query-types.js';
import { queryTimeoutError } from '../../core/query-timeout.js';
import { queryDatasourceResolver } from '../../core/resolve-query-datasource.js';
import type { TargetDiscovery } from '../../core/resolve-datasource.js';
import { RpcMethod } from '../types.js';
import type { RpcResponse } from '../types.js';
import type { DaemonMethod, Handler, HandlerDeps } from './types.js';
import { leaseSession } from '../session-lease.js';
import type { SessionLease } from '../session-lease.js';
import { requestFromWireParams } from './query-wire-request.js';

export type QueryRequestShaper = (request: QueryExecutionRequest) => QueryExecutionRequest;

export type QueryMethodOptions = {
  shapeRequest?: QueryRequestShaper;
};

type OpenSessionLease = {
  current: SessionLease | null;
};

type QueryDepsInput = {
  deps: HandlerDeps;
  response: RpcResponse;
  clientGone: AbortSignal;
  openSessionLease: OpenSessionLease;
};

const NO_TARGET_DISCOVERY: TargetDiscovery | undefined = undefined;

const resolveFromStores = queryDatasourceResolver(NO_TARGET_DISCOVERY);

function startQueryDeadline(timeoutMs: number): { signal: AbortSignal; cancel: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(queryTimeoutError(timeoutMs));
  }, timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => {
      clearTimeout(timer);
    },
  };
}

function copyOutcomeMeta(response: RpcResponse, outcomeMeta: QueryOutcome['meta']): void {
  const { schemaContext, phases, resolved, timings } = outcomeMeta;
  if (schemaContext !== undefined) {
    response.meta.schemaContext = schemaContext;
  }
  if (phases !== undefined) {
    response.meta.phases = phases;
  }
  if (resolved !== undefined) {
    response.meta.resolved = resolved;
  }
  if (timings !== undefined) {
    response.meta.timings = timings;
  }
}

function copyOutcomeIntoResponse(response: RpcResponse, outcome: QueryOutcome): void {
  copyOutcomeMeta(response, outcome.meta);
  if (outcome.ok) {
    response.ok = true;
    response.data = outcome.data;
    return;
  }
  response.error = {
    code: outcome.code,
    message: outcome.message,
    details: outcome.details,
  };
}

function queryDeps(input: QueryDepsInput): QueryDeps {
  const { deps, response, clientGone, openSessionLease } = input;
  return {
    ctx: deps.ctx,
    report: silentQueryReport,
    signal: clientGone,
    openSession: (datasource) => {
      const lease = leaseSession(deps.sessions, datasource);
      openSessionLease.current = lease;
      response.meta.sessionId = lease.sessionId;
      return lease.sessionId;
    },
    acquireQuerySlot: async (signal) => deps.queryLimiter.acquire(signal),
    resolveDatasource: async (resolveRequest, resolveDeps) => {
      const resolved = await resolveFromStores(resolveRequest, resolveDeps);
      await deps.admitDatasource(resolved.datasource, resolveRequest.timeoutMs);
      return resolved;
    },
  };
}

function queryHandler(shapeRequest: QueryRequestShaper): Handler {
  return async ({ req, base, deps, clientGone }) => {
    const request = shapeRequest(requestFromWireParams(req.params, deps.ctx));
    const deadline = startQueryDeadline(request.timeoutMs);
    const releaseQuerySlot = await deps.queryLimiter.acquire(AbortSignal.any([clientGone, deadline.signal]));
    const openSessionLease: OpenSessionLease = { current: null };
    try {
      const outcome = await executeQuery(request, queryDeps({ deps, response: base, clientGone, openSessionLease }));
      copyOutcomeIntoResponse(base, outcome);
    } finally {
      deadline.cancel();
      openSessionLease.current?.release();
      releaseQuerySlot();
    }
  };
}

export function queryMethod(options: QueryMethodOptions = {}): DaemonMethod {
  return {
    name: RpcMethod.QueryExecute,
    handle: queryHandler(options.shapeRequest ?? ((request) => request)),
  };
}
