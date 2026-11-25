import type { AppContext } from '../../core/app.js';
import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { deriveQueryTarget } from '../../core/query-target.js';
import { parseTimeoutMs } from '../../core/query-timeout.js';
import type { QueryExecutionRequest } from '../../core/query-types.js';

export function requestFromWireParams(params: Record<string, unknown>, ctx: AppContext): QueryExecutionRequest {
  const sentRequest = params as unknown as QueryExecutionRequest;
  const { env, namespace, service } = deriveQueryTarget(ctx, sentRequest);
  const timeoutDefault = ctx.runtimeConfigStore.queryTimeoutMs() ?? RUNTIME_CONSTANTS.query.defaultTimeoutMs;
  return { ...sentRequest, env, namespace, service, timeoutMs: parseTimeoutMs(params.timeoutMs, timeoutDefault) };
}
