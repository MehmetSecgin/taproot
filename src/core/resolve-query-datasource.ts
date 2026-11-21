import { environmentPolicy } from './app.js';
import { criticalDatasourceKbConflicts, datasourceKbConflicts } from './conflicts.js';
import { deterministicRequired as deterministicRequiredErr, misconfiguredDatasource } from './error-classification.js';
import type { DatasourceResolver } from './execute-query.js';
import { describeResolutionFailure, resolveDatasourceWithFallbacks, type TargetDiscovery } from './resolve-datasource.js';

export function queryDatasourceResolver(discover: TargetDiscovery | undefined): DatasourceResolver {
  return async (request, { ctx, report }) => {
    const { env, namespace, service } = request;
    const discovery = request.allowDiscovery ? discover : undefined;
    const policy = environmentPolicy(ctx, env);
    const deterministic = policy.deterministicRequired;
    report.log(`resolving datasource (${request.datasource || `${env}-${service || 'unknown'}`})`);
    const resolution = await resolveDatasourceWithFallbacks({
      ctx,
      rawDs: request.datasource,
      optsEnv: request.optsEnv,
      env,
      namespace: namespace || undefined,
      service,
      query: request.query,
      discover: discovery,
      policy,
    });
    for (const line of resolution.verboseLogs) report.log(line);
    const datasource = resolution.datasource;
    const kbMissing = !datasource && !request.datasource && env && service ? ctx.kbStore.missingReason() : undefined;
    const kbSuffix = kbMissing ? ` ${kbMissing}` : '';
    if (!datasource && deterministic && !discovery) {
      throw deterministicRequiredErr(
        `environment '${env || 'unknown'}' requires deterministic datasource resolution from profile or KB. Use --datasource or --env+--service.${kbSuffix}`,
      );
    }
    if (!datasource) throw new Error(`${describeResolutionFailure(ctx.datasourceStore.list(), { rawDs: request.datasource, env: request.optsEnv || env, namespace: namespace || undefined, service })}${kbSuffix}`);
    const warnings: string[] = [];
    if (env && service) {
      const kb = ctx.kbStore.resolveConnection(service, env, namespace || undefined);
      if (kb) {
        const critical = criticalDatasourceKbConflicts(datasource, kb);
        if (critical.length) {
          throw misconfiguredDatasource(
            `datasource '${datasource.name}' conflicts with KB for env=${env} service=${service} (${critical.join('; ')}). Datasource store blocks KB-backed execution. Repair the profile with taproot init datasource --env ${env}${namespace ? ` --namespace ${namespace}` : ''} --service ${service}.`,
          );
        }
        const conflicts = datasourceKbConflicts(datasource, kb);
        if (conflicts.length) {
          const warning = `datasource overrides KB (${conflicts.join('; ')})`;
          warnings.push(warning);
          report.log(`warning: ${warning}`);
        }
      }
    }
    return { datasource, source: resolution.source, warnings };
  };
}
