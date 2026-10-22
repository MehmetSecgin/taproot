import { classifyError, environmentPolicy, normalizeNamespace, normalizeService, parseParamPairs, runDatasourceConnectors } from './app.js';
import type { AppContext } from './app.js';
import { criticalDatasourceKbConflicts, datasourceKbConflicts } from './conflicts.js';
import { RUNTIME_CONSTANTS } from './constants.js';
import { deterministicRequired as deterministicRequiredErr, misconfiguredDatasource } from './error-classification.js';
import { applyJsonExtract, parseJsonExtractSpecs } from './json-extract.js';
import type { JsonExtractSpec } from './json-extract.js';
import { withQueryTimeout } from './query-timeout.js';
import { describeResolutionFailure, resolveDatasourceWithFallbacks } from './resolve-datasource.js';
import { collectRangeWarnings, enforceMutationPolicy, enforcePartitionPredicate } from './safety.js';
import { buildSchemaContext, suggestSchemaNames } from './schema-context.js';
import { ensureDatasourceCatalog } from './schema-refresh.js';
import { resolveSessionTimeZone } from './session-timezone.js';
import { dialectFromKind } from './sql-dialect.js';
import { str } from './strings.js';
import { DatasourceKind, DoctorStatus } from '../types/core.js';
import type { DatasourceProfile, QueryResult, SchemaContext } from '../types/core.js';
import type { BuiltinPluginParams } from '../types/plugin-params.js';

export interface QueryExecutionRequest {
  datasource?: string;
  optsEnv?: string;
  env: string;
  namespace: string;
  service: string;
  query: string;
  params: string[];
  allowDiscovery: boolean;
  allowMutate: boolean;
  allowPartitionScan: boolean;
  explain: boolean;
  rowsObject: boolean;
  jsonExtract: string[];
  proto?: string;
  protoRoot?: string;
  allowFlush: boolean;
  requestJson?: string;
  skipProtoValidate: boolean;
  timeoutMs: number;
  tz?: string;
  sessionId?: string;
}

export interface QueryReport {
  log(message: string): void;
}

export interface QueryDeps {
  ctx: AppContext;
  report: QueryReport;
  openSession?: (datasource: DatasourceProfile) => string;
}

export interface QueryOutcomeMeta {
  sessionId?: string;
  requestId?: string;
  resolved?: QueryResult['resolved'];
  phases?: NonNullable<QueryResult['timings']['phases']>;
  timings?: { durationMs: number };
  schemaContext?: SchemaContext;
}

export interface QuerySuccessData {
  columns: string[];
  rows: unknown[];
  rowsForm?: 'array';
  datasource: string;
  plugin: string;
  classification: 'success' | 'error';
  warnings?: string[];
}

export type QueryOutcome =
  | { ok: true; data: QuerySuccessData; meta: QueryOutcomeMeta }
  | { ok: false; code: string; message: string; details?: unknown; meta: QueryOutcomeMeta };

export interface QueryTarget {
  env: string;
  namespace: string;
  service: string;
  explicitProfile?: DatasourceProfile;
}

export const silentQueryReport: QueryReport = { log: () => {} };

export function deriveQueryTarget(
  ctx: AppContext,
  input: { datasource?: string; env?: string; namespace?: string; service?: string },
): QueryTarget {
  const aliases = ctx.runtimeConfigStore.serviceAliases();
  const explicitProfile = input.datasource ? ctx.datasourceStore.get(input.datasource) : undefined;
  const raw = str(input.datasource).trim().toLowerCase();
  const match = explicitProfile ? null : raw.match(/^([a-z0-9]+)-([a-z0-9-]+)$/);
  const alias = match ? { env: match[1], service: normalizeService(match[2], aliases) } : null;
  return {
    env: str(input.env || explicitProfile?.env || alias?.env).trim(),
    namespace: normalizeNamespace(str(input.namespace || explicitProfile?.namespace)),
    service: normalizeService(input.service || explicitProfile?.service || alias?.service || '', aliases),
    explicitProfile,
  };
}

function buildPluginParams(request: QueryExecutionRequest, params: Record<string, string>, kind: string): BuiltinPluginParams | undefined {
  const pluginParams: BuiltinPluginParams = {};
  if (request.proto) pluginParams.protoMessage = String(request.proto);
  if (request.protoRoot) pluginParams.protoRoot = String(request.protoRoot);
  if (request.allowFlush) pluginParams.allowFlush = true;
  if (request.requestJson) pluginParams.requestJson = String(request.requestJson);
  if (request.skipProtoValidate) pluginParams.skipProtoValidate = true;
  if (kind === DatasourceKind.Grpc && Object.keys(params).length) pluginParams.params = params;
  return Object.keys(pluginParams).length ? pluginParams : undefined;
}

function mergeSchemaContext(base: SchemaContext, pluginSchema: SchemaContext | undefined): SchemaContext {
  if (!pluginSchema) return base;
  return { ...base, ...pluginSchema, tables: { ...(base.tables || {}), ...(pluginSchema.tables || {}) } };
}

function failure(error: unknown, meta: QueryOutcomeMeta): QueryOutcome {
  const message = str((error as Error).message);
  return {
    ok: false,
    code: classifyError(message),
    message,
    details: (error as Error & { details?: unknown }).details,
    meta,
  };
}

async function resolveTargetDatasource(
  request: QueryExecutionRequest,
  deps: QueryDeps,
): Promise<{ datasource: DatasourceProfile; source: string; warnings: string[] }> {
  const { ctx, report } = deps;
  const { env, namespace, service } = request;
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
    allowDiscovery: request.allowDiscovery,
    policy,
  });
  for (const line of resolution.verboseLogs) report.log(line);
  const datasource = resolution.datasource;
  const kbMissing = !datasource && !request.datasource && env && service ? ctx.kbStore.missingReason() : undefined;
  const kbSuffix = kbMissing ? ` ${kbMissing}` : '';
  if (!datasource && deterministic && !request.allowDiscovery) {
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
          `datasource '${datasource.name}' conflicts with KB for env=${env} service=${service} (${critical.join('; ')}). Datasource store blocks KB-backed execution until the profile is repaired.`,
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
}

export async function executeQuery(request: QueryExecutionRequest, deps: QueryDeps): Promise<QueryOutcome> {
  const { ctx, report } = deps;
  const startedAt = Date.now();
  const deadlineMs = startedAt + request.timeoutMs;
  const remainingMs = (): number => Math.max(1, deadlineMs - Date.now());
  let phaseConnectMs = 0;
  let phaseExecuteMs = 0;

  let datasource: DatasourceProfile;
  let resolutionSource: string;
  const warnings: string[] = [];
  let phaseResolveMs = 0;
  try {
    const resolveStart = Date.now();
    const resolved = await resolveTargetDatasource(request, deps);
    datasource = resolved.datasource;
    resolutionSource = resolved.source;
    warnings.push(...resolved.warnings);
    phaseResolveMs = Date.now() - resolveStart;
    report.log(`datasource ready (${datasource.name})`);
  } catch (error) {
    return failure(error, {});
  }

  const sessionId = deps.openSession ? deps.openSession(datasource) : request.sessionId;
  let params: Record<string, string>;
  let jsonExtractSpecs: JsonExtractSpec[];
  const query = request.query.trim();
  try {
    params = parseParamPairs(request.params || []);
    jsonExtractSpecs = parseJsonExtractSpecs(request.jsonExtract);
    if (!query) throw new Error('No query resolved. Provide --sql.');
  } catch (error) {
    return failure(error, {});
  }
  report.log('query resolved');

  const sessionTimeZone = resolveSessionTimeZone({
    override: request.tz,
    datasourceHint: datasource.resolverHints?.timeZone,
    configDefault: ctx.runtimeConfigStore.queryTimeZone(),
  });
  const dialect = dialectFromKind(datasource.kind);
  const schemaContext = buildSchemaContext(query, dialect, ctx.schemaCatalogStore.get(datasource.name));
  void ensureDatasourceCatalog(ctx, datasource).then((catalog) => {
    if (catalog.outcome === 'failed') report.log(`schema catalog skipped: ${catalog.error}`);
    else if (catalog.outcome === 'fetched') report.log(`schema catalog cached: ${catalog.tableCount} tables`);
  });

  const capability = request.allowMutate ? 'executeMutate' : 'executeRead';
  const plugin = ctx.pluginRegistry.get(datasource.kind);
  if (!plugin?.execute) {
    return failure(new Error(`No execute-capable plugin for datasource kind '${datasource.kind}'.`), { schemaContext });
  }
  const execute = plugin.execute;
  if (!plugin.manifest.capabilities.includes(capability as any)) {
    return failure(new Error(`Plugin '${plugin.manifest.name}' does not support capability ${capability}.`), { schemaContext });
  }

  let creds = await ctx.credentialStore.get(datasource.credentialRef);
  const meta: QueryOutcomeMeta = { sessionId, schemaContext };

  try {
    enforceMutationPolicy({ sql: query, allowMutate: request.allowMutate, datasource });
    warnings.push(
      ...enforcePartitionPredicate({
        sql: query,
        schemaContext,
        dialect,
        allowPartitionScan: request.allowPartitionScan,
      }),
    );
    warnings.push(...collectRangeWarnings({ sql: query, schemaContext, dialect }));

    report.log('checking connectors');
    const connectStart = Date.now();
    const preflightBudgetMs = Math.max(remainingMs(), RUNTIME_CONSTANTS.connector.preflightTimeoutMs);
    const connectorChecks = await withQueryTimeout({
      timeoutMs: preflightBudgetMs,
      run: () =>
        runDatasourceConnectors({
          datasource,
          credentialStore: ctx.credentialStore,
          pluginRegistry: ctx.pluginRegistry,
          mode: 'connect',
        }),
    });
    phaseConnectMs = Date.now() - connectStart;
    for (const c of connectorChecks) {
      report.log(`connector ${c.check}: ${c.status}`);
    }
    if (connectorChecks.some((c) => c.status === DoctorStatus.Fail)) {
      throw new Error(
        `connector preflight failed: ${connectorChecks.filter((c) => c.status === DoctorStatus.Fail).map((c) => c.detail).join(' | ')}`,
      );
    }

    report.log(`executing query via ${plugin.manifest.name}`);
    const executeStart = Date.now();
    const executedQuery = request.explain ? `EXPLAIN ${query}` : query;
    const pluginParams = buildPluginParams(request, params, datasource.kind);
    const runExecute = (): Promise<QueryResult> =>
      withQueryTimeout({
        timeoutMs: remainingMs(),
        run: () =>
          execute(
            {
              datasource,
              query: executedQuery,
              capability: capability as any,
              timeoutMs: remainingMs(),
              sessionTimeZone,
              pluginParams,
            },
            sessionId ? { ...creds, __sessionId: sessionId } : creds,
          ),
      });

    const result: QueryResult = await runExecute();
    phaseExecuteMs = Date.now() - executeStart;

    if (warnings.length) result.warnings = [...(result.warnings || []), ...warnings];
    const phases = {
      resolveMs: phaseResolveMs,
      connectMs: phaseConnectMs,
      executeMs: phaseExecuteMs,
      totalMs: Date.now() - startedAt,
    };
    const resolved = {
      source: resolutionSource,
      env: request.env,
      namespace: datasource.namespace || request.namespace || undefined,
      service: request.service,
      accessMethod: str(ctx.kbStore.resolveConnection(request.service, request.env, request.namespace || undefined)?.access_method),
      target: str(datasource.connection.target),
      database: str(datasource.connection.database),
      engine: datasource.kind,
    };
    const mergedSchema = mergeSchemaContext(schemaContext, result.meta?.schemaContext);

    const presented = jsonExtractSpecs.length
      ? applyJsonExtract(result.result.columns || [], result.result.rows, jsonExtractSpecs)
      : { columns: result.result.columns || [], rows: result.result.rows };
    const columns = presented.columns;
    const data: QuerySuccessData = {
      columns,
      rows: request.rowsObject
        ? presented.rows
        : presented.rows.map((row) => columns.map((col) => (row as Record<string, unknown>)[col] ?? null)),
      datasource: datasource.name,
      plugin: result.plugin,
      classification: result.classification,
    };
    if (!request.rowsObject) data.rowsForm = 'array';
    if (result.warnings.length) data.warnings = result.warnings;

    return {
      ok: true,
      data,
      meta: {
        ...meta,
        resolved,
        phases,
        timings: { durationMs: result.timings.durationMs },
        schemaContext: mergedSchema,
      },
    };
  } catch (error) {
    const outcome = failure(error, meta);
    if (outcome.ok || (outcome.code !== 'UNKNOWN_COLUMN' && outcome.code !== 'UNKNOWN_TABLE')) return outcome;
    void ensureDatasourceCatalog(ctx, datasource, { force: true });
    const didYouMean = suggestSchemaNames(outcome.code, outcome.message, schemaContext, ctx.schemaCatalogStore.get(datasource.name));
    if (!didYouMean.length) return outcome;
    return {
      ...outcome,
      message: `${outcome.message}. Did you mean: ${didYouMean.join(', ')}?`,
      details: { ...((outcome.details as Record<string, unknown>) || {}), didYouMean },
    };
  }
}
