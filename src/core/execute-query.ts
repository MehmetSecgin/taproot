import fs from 'node:fs';
import path from 'node:path';
import { classifyError, environmentPolicy, normalizeNamespace, normalizeService, parseParamPairs, runDatasourceConnectors } from './app.js';
import type { AppContext } from './app.js';
import { appendEvent, createRunArtifacts, writeRunSummary } from './artifacts.js';
import { criticalDatasourceKbConflicts, datasourceKbConflicts } from './conflicts.js';
import { RUNTIME_CONSTANTS } from './constants.js';
import { deterministicRequired as deterministicRequiredErr, misconfiguredDatasource } from './error-classification.js';
import { applyJsonExtract, parseJsonExtractSpecs } from './json-extract.js';
import type { JsonExtractSpec } from './json-extract.js';
import { buildQueryMemory, resolveReason } from './query-memory.js';
import { withQueryTimeout } from './query-timeout.js';
import { liveColumnsFromSchemaContext } from './relations.js';
import { describeResolutionFailure, resolveDatasourceWithFallbacks } from './resolve-datasource.js';
import { appendRunsLedgerEntry, findRepeatFailure, ledgerInputFromResult } from './runs-ledger.js';
import { collectRangeWarnings, enforceMutationPolicy, enforcePartitionPredicate, enforceSchemaIntrospectionPolicy } from './safety.js';
import { buildSchemaContext, collectReferencedTables } from './schema-context.js';
import { ensureDatasourceCatalog, supportsSchemaRefresh } from './schema-refresh.js';
import { resolveSessionTimeZone } from './session-timezone.js';
import { dialectFromKind } from './sql-dialect.js';
import { str } from './strings.js';
import { DatasourceKind, DoctorStatus } from '../types/core.js';
import type { DatasourceProfile, QueryMemory, QueryResult, SchemaContext } from '../types/core.js';
import type { BuiltinPluginParams } from '../types/plugin-params.js';

export interface QueryExecutionRequest {
  datasource?: string;
  optsEnv?: string;
  env: string;
  namespace: string;
  service: string;
  reason?: string;
  query: string;
  params: string[];
  allowDiscovery: boolean;
  allowMutate: boolean;
  allowPartitionScan: boolean;
  allowSchemaIntrospection: boolean;
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

export type QueryPhase = 'resolve' | 'catalog' | 'connect' | 'execute';

export interface QueryReport {
  update(message: string): void;
  phase(phase: QueryPhase, ms: number): void;
  verbose(message: string): void;
  notice(message: string): void;
}

export interface QueryDeps {
  ctx: AppContext;
  report: QueryReport;
  promptPassword?: (credentialRef: string) => Promise<string>;
  openSession?: (datasource: DatasourceProfile) => string;
}

export interface QueryOutcomeMeta {
  runId?: string;
  sessionId?: string;
  requestId?: string;
  resolved?: QueryResult['resolved'];
  phases?: NonNullable<QueryResult['timings']['phases']>;
  timings?: { durationMs: number };
  schemaContext?: SchemaContext;
  queryMemory?: QueryMemory;
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

export const silentQueryReport: QueryReport = {
  update: () => {},
  phase: () => {},
  verbose: () => {},
  notice: () => {},
};

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

function priorFailureMessage(runsDir: string, runId: string): string {
  try {
    return fs.readFileSync(path.join(runsDir, runId, 'events.log'), 'utf8').match(/query failed code=\S+ message=(.*)/)?.[1] || '';
  } catch {
    return '';
  }
}

async function resolveTargetDatasource(
  request: QueryExecutionRequest,
  deps: QueryDeps,
): Promise<{ datasource: DatasourceProfile; source: string; warnings: string[] }> {
  const { ctx, report } = deps;
  const { env, namespace, service } = request;
  const policy = environmentPolicy(ctx, env);
  const deterministic = policy.deterministicRequired;
  report.update(`resolving datasource (${request.datasource || `${env}-${service || 'unknown'}`})`);
  const resolution = await resolveDatasourceWithFallbacks({
    ctx,
    rawDs: request.datasource,
    optsEnv: request.optsEnv,
    env,
    namespace: namespace || undefined,
    service,
    query: request.query,
    allowDiscovery: request.allowDiscovery,
    deterministicRequired: deterministic,
    policy,
  });
  for (const line of resolution.verboseLogs) report.verbose(line);
  const datasource = resolution.datasource;
  const kbMissing = !datasource && !request.datasource && env && service ? ctx.kbStore.missingReason() : undefined;
  const kbSuffix = kbMissing ? ` ${kbMissing}` : '';
  if (!datasource && deterministic && !request.allowDiscovery) {
    throw deterministicRequiredErr(
      `environment '${env || 'unknown'}' requires deterministic datasource resolution from profile or KB. Use --datasource or --env+--service.${kbSuffix}`,
    );
  }
  if (!datasource) throw new Error(`${describeResolutionFailure(ctx.datasourceStore.list(), { rawDs: request.datasource, env: request.optsEnv || env, namespace: namespace || undefined, service })}${kbSuffix}`);
  if (deterministic && !request.allowDiscovery && resolution.source === 'learning') {
    throw deterministicRequiredErr(
      `environment '${env || 'unknown'}' requires KB/profile-backed datasource resolution. Retry without discovery cache or enable discovery in config or CLI.`,
    );
  }
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
        report.verbose(`warning: ${warning}`);
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
    report.update(`datasource ready (${datasource.name})`);
    report.phase('resolve', phaseResolveMs);
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
  report.update('query resolved');

  const sessionTimeZone = resolveSessionTimeZone({
    override: request.tz,
    datasourceHint: datasource.resolverHints?.timeZone,
    configDefault: ctx.runtimeConfigStore.queryTimeZone(),
  });
  const dialect = dialectFromKind(datasource.kind);
  const referencedTables = collectReferencedTables(query, dialect);
  const windowMs = RUNTIME_CONSTANTS.query.repeatFailureWindowMs;
  const repeated = findRepeatFailure({ ledgerDir: ctx.paths.runsLedgerDir, datasource: datasource.name, sql: query, windowMs });
  if (repeated?.errorClass) {
    const ageMs = Date.now() - Date.parse(repeated.ts);
    const scope = repeated.errorClass === 'CONNECTIVITY' ? `datasource ${datasource.name}` : 'this query';
    return {
      ok: false,
      code: repeated.errorClass,
      message: `short-circuited without connecting: ${scope} failed with ${repeated.errorClass} ${Math.round(ageMs / 1000)}s ago (run ${repeated.runId}); the next attempt after ${Math.ceil((windowMs - ageMs) / 1000)}s runs for real. Prior error: ${priorFailureMessage(ctx.paths.runsDir, repeated.runId)}`,
      details: { shortCircuited: true, priorRunId: repeated.runId, retryAfterMs: windowMs - ageMs },
      meta: { schemaContext: buildSchemaContext(query, { service: datasource.service, datasource: datasource.name, dialect }, ctx.learningStore) },
    };
  }
  const firstCatalog = supportsSchemaRefresh(datasource) && !ctx.learningStore.schemaCatalog(datasource.name);
  if (firstCatalog) {
    report.notice(`first query against ${datasource.name}, caching its full schema catalog once`);
  }
  let phaseCatalogMs = 0;
  const catalogStart = Date.now();
  const catalogTask = ensureDatasourceCatalog(ctx, datasource).then((catalog) => {
    phaseCatalogMs = Date.now() - catalogStart;
    report.phase('catalog', phaseCatalogMs);
    if (catalog.outcome === 'failed') report.verbose(`schema catalog skipped: ${catalog.error}`);
    else if (catalog.outcome === 'fetched') report.verbose(`schema catalog cached: ${catalog.tableCount} tables`);
  });
  if (firstCatalog) await catalogTask;

  const schemaContext = buildSchemaContext(
    query,
    { service: datasource.service, datasource: datasource.name, dialect },
    ctx.learningStore,
  );
  const relationEdges = ctx.kbStore.relationsForTables(
    str(datasource.service),
    referencedTables,
    liveColumnsFromSchemaContext(schemaContext.tables),
  );
  if (relationEdges.length) schemaContext.relations = relationEdges;
  const reason = resolveReason(request.reason);
  const queryMemory = buildQueryMemory({
    ledgerDir: ctx.paths.runsLedgerDir,
    datasource: datasource.name,
    env: request.env,
    service: request.service,
    reason,
    sql: query,
    tables: referencedTables,
  });

  const capability = request.allowMutate ? 'executeMutate' : 'executeRead';
  const plugin = ctx.pluginRegistry.get(datasource.kind);
  if (!plugin?.execute) {
    return failure(new Error(`No execute-capable plugin for datasource kind '${datasource.kind}'.`), { schemaContext, queryMemory });
  }
  const execute = plugin.execute;
  if (!plugin.manifest.capabilities.includes(capability as any)) {
    await catalogTask;
    return failure(new Error(`Plugin '${plugin.manifest.name}' does not support capability ${capability}.`), { schemaContext, queryMemory });
  }

  let creds = await ctx.credentialStore.get(datasource.credentialRef);
  const artifacts = createRunArtifacts(ctx.paths.runsDir, datasource.name.replace(/[^a-z0-9-]/gi, '-'));
  const meta: QueryOutcomeMeta = { runId: artifacts.runId, sessionId, schemaContext, queryMemory };
  appendEvent(artifacts.runDir, `query started capability=${capability}`);

  try {
    enforceMutationPolicy({ sql: query, allowMutate: request.allowMutate, datasource });
    const cachedRows = ctx.learningStore.schemaTables(datasource.service);
    const hasRefreshedSchema = cachedRows.some((row) => row.sources.includes('refreshed-metadata') || row.sources.includes('manual'));
    warnings.push(
      ...enforceSchemaIntrospectionPolicy({
        sql: query,
        service: str(datasource.service),
        hasRefreshedSchema,
        allowSchemaIntrospection: request.allowSchemaIntrospection,
      }),
    );
    warnings.push(
      ...enforcePartitionPredicate({
        sql: query,
        schemaContext,
        dialect,
        allowPartitionScan: request.allowPartitionScan,
      }),
    );
    warnings.push(...collectRangeWarnings({ sql: query, schemaContext, dialect }));

    report.update('checking connectors');
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
    report.phase('connect', phaseConnectMs);
    for (const c of connectorChecks) {
      appendEvent(artifacts.runDir, `connector ${c.check} ${c.status}: ${c.detail}`);
      report.verbose(`connector ${c.check}: ${c.status}`);
    }
    if (connectorChecks.some((c) => c.status === DoctorStatus.Fail)) {
      throw new Error(
        `connector preflight failed: ${connectorChecks.filter((c) => c.status === DoctorStatus.Fail).map((c) => c.detail).join(' | ')}`,
      );
    }

    report.update(`executing query via ${plugin.manifest.name}`);
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

    let result: QueryResult;
    try {
      result = await runExecute();
    } catch (err) {
      const code = classifyError(str((err as Error).message));
      const canPromptPassword =
        code === 'ACCESS_DENIED' &&
        !creds.password &&
        Boolean(deps.promptPassword) &&
        (datasource.kind === DatasourceKind.Mysql || datasource.kind === DatasourceKind.Postgres);
      if (!canPromptPassword) throw err;
      report.update(`password required for ${datasource.credentialRef}`);
      const password = await deps.promptPassword!(datasource.credentialRef);
      if (!password) throw err;
      creds = { ...creds, password };
      await ctx.credentialStore.set(datasource.credentialRef, creds);
      report.update('retrying query');
      result = await runExecute();
    }
    phaseExecuteMs = Date.now() - executeStart;
    report.phase('execute', phaseExecuteMs);
    await catalogTask;

    result.runId = artifacts.runId;
    if (warnings.length) result.warnings = [...(result.warnings || []), ...warnings];
    const phases = {
      resolveMs: phaseResolveMs,
      catalogMs: phaseCatalogMs,
      connectMs: phaseConnectMs,
      executeMs: phaseExecuteMs,
      totalMs: Date.now() - startedAt,
    };
    result.timings = { ...result.timings, phases };
    result.resolved = {
      source: resolutionSource,
      env: request.env,
      namespace: datasource.namespace || request.namespace || undefined,
      service: request.service,
      accessMethod: str(ctx.kbStore.resolveConnection(request.service, request.env, request.namespace || undefined)?.access_method),
      target: str(datasource.connection.target),
      database: str(datasource.connection.database),
      engine: datasource.kind,
    };
    const pluginMeta = result.meta || {};
    const mergedSchema = mergeSchemaContext(schemaContext, pluginMeta.schemaContext);
    result.meta = { ...pluginMeta, schemaContext: mergedSchema, queryMemory };

    appendRunsLedgerEntry(
      ledgerInputFromResult({
        ledgerDir: ctx.paths.runsLedgerDir,
        result,
        datasource,
        reason,
        sql: query,
        tables: referencedTables,
        redactionTier: ctx.runtimeConfigStore.ledgerRedactionTier(request.env || datasource.env),
        sessionId,
      }),
    );
    writeRunSummary(artifacts.runDir, result);
    appendEvent(artifacts.runDir, 'query succeeded');
    ctx.learningStore.saveSuccess({ datasource, sql: query });

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
        resolved: result.resolved,
        phases,
        timings: { durationMs: result.timings.durationMs },
        schemaContext: mergedSchema,
      },
    };
  } catch (error) {
    await catalogTask;
    const message = str((error as Error).message);
    const code = classifyError(message);
    appendEvent(artifacts.runDir, `query failed code=${code} message=${message}`);
    ctx.learningStore.saveFailure(datasource);
    appendRunsLedgerEntry({
      ledgerDir: ctx.paths.runsLedgerDir,
      runId: artifacts.runId,
      sessionId,
      datasource,
      reason,
      sql: query,
      tables: referencedTables,
      capability: capability as any,
      outcomeCode: code,
      errorClass: code,
      redactionTier: ctx.runtimeConfigStore.ledgerRedactionTier(request.env || datasource.env),
    });
    return failure(error, meta);
  }
}
