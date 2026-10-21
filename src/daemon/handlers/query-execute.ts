import { environmentPolicy, nextAction } from '../../core/app.js';
import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { discoveryUnavailable } from '../../core/error-classification.js';
import { deriveQueryTarget, executeQuery, silentQueryReport } from '../../core/execute-query.js';
import type { QueryExecutionRequest } from '../../core/execute-query.js';
import { parseTimeoutMs, queryTimeoutError } from '../../core/query-timeout.js';
import { str } from '../../core/strings.js';
import type { Handler } from './types.js';

function buildRequest(params: Record<string, unknown>, target: { env: string; namespace: string; service: string }, timeoutMs: number): QueryExecutionRequest {
  const rawParams = Array.isArray(params.params) ? (params.params as unknown[]).map((v) => String(v)) : [];
  return {
    datasource: params.datasource ? String(params.datasource) : undefined,
    optsEnv: params.optsEnv ? String(params.optsEnv) : params.env ? String(params.env) : undefined,
    env: target.env,
    namespace: target.namespace,
    service: target.service,
    reason: str(params.reason) || undefined,
    query: str(params.query),
    params: rawParams,
    allowDiscovery: Boolean(params.allowDiscovery),
    allowMutate: Boolean(params.allowMutate),
    allowPartitionScan: Boolean(params.allowPartitionScan),
    allowSchemaIntrospection: Boolean(params.allowSchemaIntrospection),
    explain: Boolean(params.explain),
    rowsObject: Boolean(params.rowsObject),
    jsonExtract: Array.isArray(params.jsonExtract) ? (params.jsonExtract as unknown[]).map((v) => String(v)) : [],
    proto: params.proto ? String(params.proto) : undefined,
    protoRoot: params.protoRoot ? String(params.protoRoot) : undefined,
    allowFlush: Boolean(params.allowFlush),
    requestJson: params.requestJson ? String(params.requestJson) : undefined,
    skipProtoValidate: Boolean(params.skipProtoValidate),
    timeoutMs,
    tz: str(params.tz) || undefined,
  };
}

export const handleQueryExecute: Handler = async ({ req, base, deps }) => {
  const { ctx, sessions, queryLimiter } = deps;
  const target = deriveQueryTarget(ctx, {
    datasource: str(req.params.datasource),
    env: str(req.params.env),
    namespace: str(req.params.namespace),
    service: str(req.params.service),
  });
  const policy = environmentPolicy(ctx, target.env);
  if (Boolean(req.params.allowDiscovery) || policy.allowDiscoveryByDefault) {
    throw discoveryUnavailable('discovery mode is only available in direct CLI mode when daemon is bypassed.');
  }

  const timeoutDefault = ctx.runtimeConfigStore.queryTimeoutMs() ?? RUNTIME_CONSTANTS.query.defaultTimeoutMs;
  const timeoutMs = parseTimeoutMs(req.params.timeoutMs, timeoutDefault);
  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => timeoutController.abort(queryTimeoutError(timeoutMs)), timeoutMs);
  const releaseGlobal = await queryLimiter.acquire({ signal: timeoutController.signal });
  let leaseSessionId = '';
  let leaseId = '';
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    const request = buildRequest(req.params, target, timeoutMs);
    const resolvedProfile = target.explicitProfile;
    const session = sessions.open({
      datasourceName: resolvedProfile?.name || str(req.params.datasource) || `${target.env}-${target.service}`,
      env: resolvedProfile?.env || target.env,
      namespace: resolvedProfile?.namespace || target.namespace,
      service: resolvedProfile?.service || target.service,
      kind: resolvedProfile?.kind || '',
      connection: (resolvedProfile?.connection || {}) as Record<string, unknown>,
      connectors: resolvedProfile?.connectors || [],
    });
    leaseSessionId = session.sessionId;
    leaseId = sessions.acquireLease(session.sessionId);
    base.meta.sessionId = session.sessionId;
    heartbeat = setInterval(
      () => sessions.heartbeatLease(session.sessionId, leaseId),
      RUNTIME_CONSTANTS.session.leaseHeartbeatIntervalMs,
    );

    const outcome = await executeQuery({ ...request, sessionId: session.sessionId }, { ctx, report: silentQueryReport });
    const meta = outcome.meta;
    if (meta.runId) base.meta.runId = meta.runId;
    if (meta.schemaContext) base.meta.schemaContext = meta.schemaContext;
    if (meta.queryMemory) base.meta.queryMemory = meta.queryMemory;
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
      details: {
        ...((outcome.details as Record<string, unknown>) || {}),
        nextAction: nextAction(outcome.code),
      },
    };
  } finally {
    clearTimeout(timeoutTimer);
    if (heartbeat) clearInterval(heartbeat);
    if (leaseSessionId && leaseId) sessions.releaseLease(leaseSessionId, leaseId);
    releaseGlobal();
  }
};
