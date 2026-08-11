import { classifyError, environmentPolicy, normalizeNamespace, normalizeService, parseParamPairs, runDatasourceConnectors } from '../../core/app.js';
import { appendEvent, createRunArtifacts, writeRunSummary } from '../../core/artifacts.js';
import { criticalDatasourceKbConflicts, datasourceKbConflicts } from '../../core/conflicts.js';
import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { collectRangeWarnings, enforceMutationPolicy, enforcePartitionPredicate, enforceSchemaIntrospectionPolicy } from '../../core/safety.js';
import { deterministicRequired, discoveryUnavailable, misconfiguredDatasource } from '../../core/error-classification.js';
import { parseTimeoutMs, queryTimeoutError, withQueryTimeout } from '../../core/query-timeout.js';
import { resolveCanonicalDatasource } from '../../core/resolve-datasource.js';
import { resolveSessionTimeZone } from '../../core/session-timezone.js';
import { str } from '../../core/strings.js';
import { DatasourceKind, DoctorStatus } from '../../types/core.js';
import type { DatasourceProfile, QueryResult, SchemaContext } from '../../types/core.js';
import type { BuiltinPluginParams } from '../../types/plugin-params.js';
import { ensureDatasourceCatalog } from '../../core/schema-refresh.js';
import { buildSchemaContext, collectReferencedTables } from '../../core/schema-context.js';
import { dialectFromKind } from '../../core/sql-dialect.js';
import { liveColumnsFromSchemaContext } from '../../core/relations.js';
import { appendRunsLedgerEntry, ledgerInputFromResult } from '../../core/runs-ledger.js';
import { buildQueryMemory, resolveReason } from '../../core/query-memory.js';
import type { AppContext } from '../../core/app.js';
import type { Handler } from './types.js';

function parseQueryParams(params: Record<string, unknown>): Record<string, string> {
  if (Array.isArray(params.param)) return parseParamPairs(params.param.map((v) => String(v)));
  if (params.params && typeof params.params === 'object') {
    return Object.fromEntries(Object.entries(params.params as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  }
  return {};
}

function buildPluginParams(
  reqParams: Record<string, unknown>,
  datasourceKind: string,
): BuiltinPluginParams | undefined {
  const pluginParams: BuiltinPluginParams = {};
  if (reqParams.proto) pluginParams.protoMessage = String(reqParams.proto);
  if (reqParams.protoRoot) pluginParams.protoRoot = String(reqParams.protoRoot);
  if (reqParams.allowFlush) pluginParams.allowFlush = true;
  if (reqParams.requestJson) pluginParams.requestJson = String(reqParams.requestJson);
  if (reqParams.skipProtoValidate) pluginParams.skipProtoValidate = true;
  if (datasourceKind === DatasourceKind.Grpc && reqParams.param) {
    const grpcParams: Record<string, string> = {};
    for (const pair of reqParams.param as string[]) {
      const idx = pair.indexOf('=');
      if (idx > 0) grpcParams[pair.slice(0, idx)] = pair.slice(idx + 1);
    }
    if (Object.keys(grpcParams).length) pluginParams.params = grpcParams;
  }
  return Object.keys(pluginParams).length ? pluginParams : undefined;
}

function mergeSchemaContext(
  base: SchemaContext,
  pluginSchema: SchemaContext | undefined,
): SchemaContext {
  if (!pluginSchema) return base;
  return {
    ...base,
    ...pluginSchema,
    tables: { ...(base.tables || {}), ...(pluginSchema.tables || {}) },
  };
}

function buildResolvedMeta(input: {
  ctx: AppContext;
  datasource: DatasourceProfile;
  env: string;
  namespace: string;
  service: string;
  source: string;
}): NonNullable<QueryResult['resolved']> {
  const { ctx, datasource, env, namespace, service, source } = input;
  return {
    source,
    env,
    namespace: datasource.namespace || namespace || undefined,
    service,
    accessMethod: str(ctx.kbStore.resolveConnection(service, env, namespace || undefined)?.access_method),
    target: str(datasource.connection.target),
    database: str(datasource.connection.database),
    engine: datasource.kind,
  };
}

export const handleQueryExecute: Handler = async ({ req, base, deps }) => {
  const { ctx, sessions, queryLimiter } = deps;
  const phaseStart = Date.now();
  let phaseResolveMs = 0;
  let phaseConnectMs = 0;
  let phaseExecuteMs = 0;
  const allowDiscovery = Boolean(req.params.allowDiscovery);
  const rawDs = str(req.params.datasource).trim();
  const alias = rawDs.match(/^([a-z0-9]+)-([a-z0-9-]+)$/i);
  const env = str(req.params.env || alias?.[1]).trim();
  const namespace = normalizeNamespace(str(req.params.namespace));
  const service = normalizeService(str(req.params.service || alias?.[2]), ctx.runtimeConfigStore.serviceAliases());
  const policy = environmentPolicy(ctx, env);
  if (allowDiscovery || policy.allowDiscoveryByDefault) {
    throw discoveryUnavailable('discovery mode is only available in direct CLI mode when daemon is bypassed.');
  }
  const resolution = await resolveCanonicalDatasource({ ctx, rawDs, env, namespace, service });
  const datasource = resolution.datasource;
  const resolutionSource = resolution.source;
  if (!datasource) {
    if (policy.deterministicRequired) {
      throw deterministicRequired(`environment '${env || 'unknown'}' requires datasource profile/KB resolution. Use --datasource or --env+--service.`);
    }
    throw new Error('Datasource resolution failed. Use --datasource or --env+--service.');
  }

  phaseResolveMs = Date.now() - phaseStart;
  const sessionTimeZone = resolveSessionTimeZone({
    override: str(req.params.tz),
    datasourceHint: datasource.resolverHints?.timeZone,
    configDefault: ctx.runtimeConfigStore.queryTimeZone(),
  });
  const timeoutDefault = ctx.runtimeConfigStore.queryTimeoutMs() ?? RUNTIME_CONSTANTS.query.defaultTimeoutMs;
  const timeoutMs = parseTimeoutMs(req.params.timeoutMs, timeoutDefault);
  const timeoutController = new AbortController();
  const timeoutTimer = setTimeout(() => {
    timeoutController.abort(queryTimeoutError(timeoutMs));
  }, timeoutMs);
  const startedAtMs = Date.now();
  const remainingTimeoutMs = (): number => Math.max(1, timeoutMs - (Date.now() - startedAtMs));
  const releaseGlobal = await queryLimiter.acquire({ signal: timeoutController.signal });
  let leaseSessionId = '';
  let leaseId = '';
  let heartbeat: NodeJS.Timeout | undefined;
  try {
    const warnings: string[] = [];
    if (env && service) {
      const kb = ctx.kbStore.resolveConnection(service, env, namespace || undefined);
      if (kb) {
        const critical = criticalDatasourceKbConflicts(datasource as DatasourceProfile, kb);
        if (critical.length) {
          throw misconfiguredDatasource(
            `datasource '${datasource.name}' conflicts with KB for env=${env} service=${service} (${critical.join('; ')}). Datasource store blocks KB-backed execution until the profile is repaired.`,
          );
        }
        const conflicts = datasourceKbConflicts(datasource as DatasourceProfile, kb);
        if (conflicts.length) warnings.push(`datasource overrides KB (${conflicts.join('; ')})`);
      }
    }
    const session = sessions.open({
      datasourceName: datasource.name,
      env: datasource.env,
      namespace: datasource.namespace,
      service: datasource.service,
      kind: datasource.kind,
      connection: datasource.connection as Record<string, unknown>,
      connectors: datasource.connectors || [],
    });
    leaseSessionId = session.sessionId;
    leaseId = sessions.acquireLease(session.sessionId);
    base.meta.sessionId = session.sessionId;
    heartbeat = setInterval(
      () => sessions.heartbeatLease(session.sessionId, leaseId),
      RUNTIME_CONSTANTS.session.leaseHeartbeatIntervalMs,
    );
    const query = str(req.params.query).trim();
    const effectiveIntent = str(req.params.intent);
    if (!query) throw new Error('No query resolved. Provide --query/--sql.');
    const allowMutate = Boolean(req.params.allowMutate);
    const dialect = dialectFromKind(datasource.kind);
    const referencedTables = collectReferencedTables(query, dialect);
    await ensureDatasourceCatalog(ctx, datasource as DatasourceProfile);
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
    const reason = resolveReason(str(req.params.reason));
    const queryMemory = buildQueryMemory({
      ledgerDir: ctx.paths.runsLedgerDir,
      datasource: datasource.name,
      env,
      service,
      intent: effectiveIntent,
      reason,
      sql: query,
      tables: referencedTables,
    });
    base.meta.schemaContext = schemaContext;
    base.meta.queryMemory = queryMemory;
    const capability = allowMutate ? 'executeMutate' : 'executeRead';
    const plugin = ctx.pluginRegistry.get(datasource.kind);
    if (!plugin?.execute) throw new Error(`No execute plugin for '${datasource.kind}'.`);
    const execute = plugin.execute;
    if (!plugin.manifest.capabilities.includes(capability as any)) throw new Error(`Plugin '${plugin.manifest.name}' does not support ${capability}.`);
    const creds = await ctx.credentialStore.get(datasource.credentialRef);
    const execCreds = { ...creds, __sessionId: session.sessionId };
    const artifacts = createRunArtifacts(ctx.paths.runsDir, datasource.name.replace(/[^a-z0-9-]/gi, '-'));
    base.meta.runId = artifacts.runId;
    appendEvent(artifacts.runDir, `daemon query started capability=${capability} requestId=${req.requestId}`);
    try {
      enforceMutationPolicy({ sql: query, allowMutate, datasource: datasource as DatasourceProfile });
      {
        const cachedRows = ctx.learningStore.schemaTables(datasource.service);
        const hasRefreshedSchema = cachedRows.some((row) => row.sources.includes('refreshed-metadata') || row.sources.includes('manual'));
        warnings.push(
          ...enforceSchemaIntrospectionPolicy({
            sql: query,
            service: str(datasource.service),
            hasRefreshedSchema,
            allowSchemaIntrospection: Boolean(req.params.allowSchemaIntrospection),
          }),
        );
      }
      warnings.push(
        ...enforcePartitionPredicate({
          sql: query,
          schemaContext,
          dialect,
          allowPartitionScan: Boolean(req.params.allowPartitionScan),
        }),
      );
      warnings.push(...collectRangeWarnings({ sql: query, schemaContext, dialect }));
      const connectStart = Date.now();
      const connectorChecks = await runDatasourceConnectors({
        datasource: datasource as DatasourceProfile,
        credentialStore: ctx.credentialStore,
        pluginRegistry: ctx.pluginRegistry,
        mode: 'connect',
      });
      phaseConnectMs = Date.now() - connectStart;
      for (const c of connectorChecks) appendEvent(artifacts.runDir, `connector ${c.check} ${c.status}: ${c.detail}`);
      if (connectorChecks.some((c) => c.status === DoctorStatus.Fail)) {
        throw new Error(`connector preflight failed: ${connectorChecks.filter((c) => c.status === DoctorStatus.Fail).map((c) => c.detail).join(' | ')}`);
      }
      const testHoldMs = Number(req.params._testHoldMs || 0);
      const executeStart = Date.now();
      const result = await withQueryTimeout({
        timeoutMs: remainingTimeoutMs(),
        run: async () => {
          if (process.env.NODE_ENV === 'test' && testHoldMs > 0) {
            await new Promise((r) => setTimeout(r, testHoldMs));
          }
          return await execute(
            {
              datasource: datasource as DatasourceProfile,
              query,
              capability: capability as any,
              timeoutMs: remainingTimeoutMs(),
              sessionTimeZone,
              pluginParams: buildPluginParams(req.params, datasource.kind),
            },
            execCreds,
          );
        },
      });
      result.resolved = buildResolvedMeta({
        ctx,
        datasource,
        env,
        namespace,
        service,
        source: resolutionSource,
      });
      phaseExecuteMs = Date.now() - executeStart;
      result.runId = artifacts.runId;
      if (warnings.length) result.warnings = [...(result.warnings || []), ...warnings];
      const phases = {
        resolveMs: phaseResolveMs,
        connectMs: phaseConnectMs,
        executeMs: phaseExecuteMs,
        totalMs: Date.now() - phaseStart,
      };
      result.timings = { ...result.timings, phases };
      (base.meta as Record<string, unknown>).phases = phases;
      (base.meta as Record<string, unknown>).resolved = result.resolved;
      const pluginMeta = result.meta || {};
      const mergedSchema = mergeSchemaContext(schemaContext, pluginMeta.schemaContext);
      result.meta = { ...pluginMeta, schemaContext: mergedSchema, queryMemory };
      base.meta.schemaContext = mergedSchema;
      appendRunsLedgerEntry(
        ledgerInputFromResult({
          ledgerDir: ctx.paths.runsLedgerDir,
          result,
          datasource: datasource as DatasourceProfile,
          intent: effectiveIntent,
          reason,
          sql: query,
          tables: referencedTables,
          redactionTier: ctx.runtimeConfigStore.ledgerRedactionTier(env || datasource.env),
          sessionId: session.sessionId,
        }),
      );
      writeRunSummary(artifacts.runDir, result);
      appendEvent(artifacts.runDir, `daemon query succeeded requestId=${req.requestId}`);
      ctx.learningStore.saveSuccess({ datasource: datasource as DatasourceProfile, sql: query });
      const rowsObject = Boolean(req.params.rowsObject);
      const cols = result.result.columns || [];
      const projectedRows = rowsObject
        ? result.result.rows
        : result.result.rows.map((row) => cols.map((col) => (row as Record<string, unknown>)[col] ?? null));
      const baseData: Record<string, unknown> = {
        columns: cols,
        rows: projectedRows,
        datasource: datasource.name,
        plugin: result.plugin,
        classification: result.classification,
      };
      if (!rowsObject) baseData.rowsForm = 'array';
      const combinedWarnings = [...(result.warnings || []), ...warnings];
      if (combinedWarnings.length) baseData.warnings = combinedWarnings;
      base.ok = true;
      base.data = baseData;
    } catch (error) {
      const message = (error as Error).message;
      const code = classifyError(message);
      appendEvent(artifacts.runDir, `daemon query failed code=${code} message=${message}`);
      ctx.learningStore.saveFailure(datasource as DatasourceProfile);
      appendRunsLedgerEntry({
        ledgerDir: ctx.paths.runsLedgerDir,
        runId: artifacts.runId,
        sessionId: session.sessionId,
        datasource: datasource as DatasourceProfile,
        intent: effectiveIntent,
        reason,
        sql: query,
        tables: referencedTables,
        capability: capability as any,
        outcomeCode: code,
        errorClass: code,
        redactionTier: ctx.runtimeConfigStore.ledgerRedactionTier(env || datasource.env),
      });
      throw error;
    }
  } finally {
    clearTimeout(timeoutTimer);
    if (heartbeat) clearInterval(heartbeat);
    if (leaseSessionId && leaseId) sessions.releaseLease(leaseSessionId, leaseId);
    releaseGlobal();
  }
};
