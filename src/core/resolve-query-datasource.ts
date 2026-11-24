import type { AppContext } from './app.js';
import { blockingDatasourceKbConflicts, datasourceKbConflicts } from './conflicts.js';
import { describeResolutionFailure } from './datasource-resolution-failure.js';
import { deterministicRequiredError, misconfiguredDatasource } from './taproot-error.js';
import type { DatasourceResolver, QueryExecutionRequest } from './query-types.js';
import { resolveDatasourceWithFallbacks } from './resolve-datasource.js';
import type { TargetDiscovery } from './resolve-datasource.js';
import type { DatasourceProfile } from '../types/datasource.js';
import type { EnvironmentPolicy } from '../store/runtime-config.js';
import { emptyToUndefined, isNonEmpty } from './text-presence.js';

type ResolverDeps = Parameters<DatasourceResolver>[1];

type UnresolvedDatasource = {
  request: QueryExecutionRequest;
  ctx: AppContext;
  canDiscover: boolean;
  policy: EnvironmentPolicy;
};

function missingKbSuffix(ctx: AppContext, request: QueryExecutionRequest): string {
  const hasTarget = request.env !== '' && request.service !== '';
  const reason = !isNonEmpty(request.datasource) && hasTarget ? ctx.kbStore.missingReason() : undefined;
  return isNonEmpty(reason) ? ` ${reason}` : '';
}

function unresolvedDatasourceError(failure: UnresolvedDatasource): Error {
  const { request, ctx, canDiscover, policy } = failure;
  const { env, namespace, service } = request;
  const kbSuffix = missingKbSuffix(ctx, request);
  if (policy.deterministicRequired && !canDiscover) {
    return deterministicRequiredError(
      `environment '${env === '' ? 'unknown' : env}' requires deterministic datasource resolution from profile or KB. Use --datasource or --env+--service.${kbSuffix}`,
    );
  }
  const message = describeResolutionFailure(ctx.datasourceStore.list(), {
    datasourceName: request.datasource,
    env: isNonEmpty(request.optsEnv) ? request.optsEnv : env,
    namespace: emptyToUndefined(namespace),
    service,
  });
  return new Error(`${message}${kbSuffix}`);
}

function criticalConflictError(datasource: DatasourceProfile, request: QueryExecutionRequest, critical: string[]): Error {
  const { env, namespace, service } = request;
  const namespaceFlag = namespace === '' ? '' : ` --namespace ${namespace}`;
  return misconfiguredDatasource(
    `datasource '${datasource.name}' conflicts with KB for env=${env} service=${service} (${critical.join('; ')}). Datasource store blocks KB-backed execution. Repair the profile with taproot init datasource --env ${env}${namespaceFlag} --service ${service}.`,
  );
}

function overrideWarnings(conflicts: string[], deps: ResolverDeps): string[] {
  if (conflicts.length === 0) {
    return [];
  }
  const warning = `datasource overrides KB (${conflicts.join('; ')})`;
  deps.report.log(`warning: ${warning}`);
  return [warning];
}

function kbConnectionOf(request: QueryExecutionRequest, ctx: AppContext): Record<string, unknown> | null {
  const { env, namespace, service } = request;
  return env !== '' && service !== '' ? ctx.kbStore.resolveConnection(service, env, emptyToUndefined(namespace)) : null;
}

function kbConflictWarnings(datasource: DatasourceProfile, request: QueryExecutionRequest, deps: ResolverDeps): string[] {
  const kb = kbConnectionOf(request, deps.ctx);
  if (kb === null) {
    return [];
  }
  const critical = blockingDatasourceKbConflicts(datasource, kb);
  if (critical.length > 0) {
    throw criticalConflictError(datasource, request, critical);
  }
  return overrideWarnings(datasourceKbConflicts(datasource, kb), deps);
}

function describeResolvingTarget(request: QueryExecutionRequest): string {
  if (isNonEmpty(request.datasource)) {
    return request.datasource;
  }
  return `${request.env}-${request.service === '' ? 'unknown' : request.service}`;
}

function logEachLine(report: ResolverDeps['report'], lines: string[]): void {
  for (const line of lines) {
    report.log(line);
  }
}

export function queryDatasourceResolver(discover: TargetDiscovery | undefined): DatasourceResolver {
  return async (request, deps) => {
    const { ctx, report } = deps;
    const discovery = request.allowDiscovery ? discover : undefined;
    const policy = ctx.runtimeConfigStore.environmentPolicy(request.env);
    report.log(`resolving datasource (${describeResolvingTarget(request)})`);
    const resolution = await resolveDatasourceWithFallbacks({
      ctx,
      datasourceName: request.datasource,
      explicitEnvFlag: request.optsEnv,
      effectiveEnv: request.env,
      namespace: emptyToUndefined(request.namespace),
      service: request.service,
      query: request.query,
      discover: discovery,
      policy,
    });
    logEachLine(report, resolution.verboseLogs);
    if (resolution.datasource === undefined) {
      throw unresolvedDatasourceError({ request, ctx, canDiscover: discovery !== undefined, policy });
    }
    const warnings = kbConflictWarnings(resolution.datasource, request, deps);
    return { datasource: resolution.datasource, source: resolution.source, warnings };
  };
}
