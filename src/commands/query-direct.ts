import { createInterface } from 'node:readline/promises';
import { randomUUID } from 'node:crypto';
import { stdin as input, stdout as output } from 'node:process';
import { classifyError, normalizeService, parseParamPairs, runDatasourceConnectors } from '../core/app.js';
import { appendEvent, createRunArtifacts, writeRunSummary } from '../core/artifacts.js';
import { criticalDatasourceKbConflicts, datasourceKbConflicts } from '../core/conflicts.js';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { deterministicRequired as deterministicRequiredErr, misconfiguredDatasource } from '../core/error-classification.js';
import { printJsonPluck, renderSchemaContextFooter, renderTableSmart, trimQueryJsonEnvelope } from '../core/output.js';
import { applyJsonExtract, parseJsonExtractSpecs } from '../core/json-extract.js';
import { withQueryTimeout } from '../core/query-timeout.js';
import { resolveSessionTimeZone } from '../core/session-timezone.js';
import { resolveDatasourceWithFallbacks } from '../core/resolve-datasource.js';
import { collectRangeWarnings, enforceMutationPolicy, enforcePartitionPredicate, enforceSchemaIntrospectionPolicy } from '../core/safety.js';
import { buildSchemaContext, collectReferencedTables } from '../core/schema-context.js';
import { dialectFromKind } from '../core/sql-dialect.js';
import { liveColumnsFromSchemaContext } from '../core/relations.js';
import { appendRunsLedgerEntry, ledgerInputFromResult } from '../core/runs-ledger.js';
import { buildQueryMemory, renderQueryMemoryTty, resolveReason } from '../core/query-memory.js';
import { ensureDatasourceCatalog, supportsSchemaRefresh } from '../core/schema-refresh.js';
import { str } from '../core/strings.js';
import { DatasourceKind, DoctorStatus } from '../types/core.js';
import type { BuiltinPluginParams } from '../types/plugin-params.js';
import type { DatasourceProfile } from '../types/core.js';
import { environmentPolicy } from '../core/app.js';
import type { QueryEnv } from './query-types.js';

function rowFromArray(columns: string[], row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) out[c] = row[c];
  return out;
}

function misconfiguredDatasourceError(datasourceName: string, env: string, service: string, conflicts: string[]): Error {
  return misconfiguredDatasource(
    `datasource '${datasourceName}' conflicts with KB for env=${env} service=${service} (${conflicts.join('; ')}). Datasource store blocks KB-backed execution until the profile is repaired.`,
  );
}

async function promptPassword(ref: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const value = await rl.question(`Password for ${ref}: `);
    return value.trim();
  } finally {
    rl.close();
  }
}

async function resolveDirect(qenv: QueryEnv): Promise<{ datasource: DatasourceProfile; resolutionSource: string; service: string; warnings: string[]; phaseResolveMs: number }> {
  const { ctx, opts, progress, logVerbose, env, namespace, allowDiscovery, explicitProfile, alias } = qenv;
  const aliases = ctx.runtimeConfigStore.serviceAliases();
  const policy = environmentPolicy(ctx, env);
  const phaseStart = Date.now();
  const service = normalizeService(opts.service || explicitProfile?.service || alias?.service || '', aliases);
  progress.update(`resolving datasource (${opts.datasource || `${env}-${service || 'unknown'}`})`);
  const deterministicRequired = policy.deterministicRequired;
  const resolution = await resolveDatasourceWithFallbacks({
    ctx,
    rawDs: opts.datasource,
    optsEnv: opts.env,
    env,
    namespace: namespace || undefined,
    service,
    allowDiscovery,
    deterministicRequired,
    policy,
  });
  for (const line of resolution.verboseLogs) logVerbose(line);
  const datasource = resolution.datasource;
  const resolutionSource = resolution.source;
  if (!datasource && deterministicRequired && !allowDiscovery) {
    throw deterministicRequiredErr(`environment '${env || 'unknown'}' requires deterministic datasource resolution from profile or KB. Use --datasource or --env+--service.`);
  }
  if (!datasource) throw new Error('Datasource resolution failed. Use --datasource or --env+--service.');
  if (deterministicRequired && !allowDiscovery && resolutionSource === 'learning') {
    throw deterministicRequiredErr(`environment '${env || 'unknown'}' requires KB/profile-backed datasource resolution. Retry without discovery cache or enable discovery in config or CLI.`);
  }
  const warnings: string[] = [];
  if (env && service) {
    const kb = ctx.kbStore.resolveConnection(service, env, namespace || undefined);
    if (kb) {
      const critical = criticalDatasourceKbConflicts(datasource, kb);
      if (critical.length) {
        throw misconfiguredDatasourceError(datasource.name, env, service, critical);
      }
      const conflicts = datasourceKbConflicts(datasource, kb);
      if (conflicts.length) {
        const warning = `datasource overrides KB (${conflicts.join('; ')})`;
        warnings.push(warning);
        logVerbose(`warning: ${warning}`);
      }
    }
  }
  const phaseResolveMs = Date.now() - phaseStart;
  progress.update(`datasource ready (${datasource.name})`);
  logVerbose(`phase resolve: ${phaseResolveMs}ms`);
  return { datasource, resolutionSource, service, warnings, phaseResolveMs };
}

export async function runDirectQuery(qenv: QueryEnv): Promise<void> {
  const { ctx, opts, progress, logVerbose, env, namespace, timeoutMs } = qenv;
  const phaseStart = Date.now();
  let phaseConnectMs = 0;
  let phaseExecuteMs = 0;
  const resolved = await resolveDirect(qenv);
  const { datasource, resolutionSource, service, warnings, phaseResolveMs } = resolved;
  const sessionTimeZone = resolveSessionTimeZone({
    override: opts.tz,
    datasourceHint: datasource.resolverHints?.timeZone,
    configDefault: ctx.runtimeConfigStore.queryTimeZone(),
  });
  const jsonExtractSpecs = parseJsonExtractSpecs(opts.jsonExtract);

  const params = parseParamPairs(opts.param || []);
  const effectiveIntent = opts.intent || '';
  const query = (opts.query || '').trim();
  if (!query) throw new Error('No query resolved. Provide --query/--sql.');
  progress.update('query resolved');

  const dialect = dialectFromKind(datasource.kind);
  const referencedTables = collectReferencedTables(query, dialect);
  if (supportsSchemaRefresh(datasource) && !ctx.learningStore.schemaCatalog(datasource.name) && !ctx.jsonMode) {
    process.stderr.write(`[taproot] first query against ${datasource.name}, caching its full schema catalog once\n`);
  }
  const catalog = await ensureDatasourceCatalog(ctx, datasource);
  if (catalog.outcome === 'failed') logVerbose(`schema catalog skipped: ${catalog.error}`);
  else if (catalog.outcome === 'fetched') logVerbose(`schema catalog cached: ${catalog.tableCount} tables`);
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
  const reason = resolveReason(opts.reason);
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
  const capability = opts.allowMutate ? 'executeMutate' : 'executeRead';
  const plugin = ctx.pluginRegistry.get(datasource.kind);
  if (!plugin?.execute) throw new Error(`No execute-capable plugin for datasource kind '${datasource.kind}'.`);
  const execute = plugin.execute;
  if (!plugin.manifest.capabilities.includes(capability as any)) {
    throw new Error(`Plugin '${plugin.manifest.name}' does not support capability ${capability}.`);
  }

  let creds = await ctx.credentialStore.get(datasource.credentialRef);
  const artifacts = createRunArtifacts(ctx.paths.runsDir, datasource.name.replace(/[^a-z0-9-]/gi, '-'));
  appendEvent(artifacts.runDir, `query started capability=${capability}`);
  try {
    enforceMutationPolicy({ sql: query, allowMutate: Boolean(opts.allowMutate), datasource });
    {
      const cachedRows = ctx.learningStore.schemaTables(datasource.service);
      const hasRefreshedSchema = cachedRows.some((row) => row.sources.includes('refreshed-metadata') || row.sources.includes('manual'));
      warnings.push(
        ...enforceSchemaIntrospectionPolicy({
          sql: query,
          service: str(datasource.service),
          hasRefreshedSchema,
          allowSchemaIntrospection: Boolean(opts.allowSchemaIntrospection),
        }),
      );
    }
    warnings.push(
      ...enforcePartitionPredicate({
        sql: query,
        schemaContext,
        dialect,
        allowPartitionScan: Boolean(opts.allowPartitionScan),
      }),
    );
    warnings.push(...collectRangeWarnings({ sql: query, schemaContext, dialect }));
    const executedQuery = opts.explain ? `EXPLAIN ${query}` : query;
    progress.update('checking connectors');
    const connectStart = Date.now();
    const preflightBudgetMs = Math.max(timeoutMs, RUNTIME_CONSTANTS.connector.preflightTimeoutMs);
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
    logVerbose(`phase connect: ${phaseConnectMs}ms`);
    for (const c of connectorChecks) appendEvent(artifacts.runDir, `connector ${c.check} ${c.status}: ${c.detail}`);
    for (const c of connectorChecks) logVerbose(`connector ${c.check}: ${c.status}`);
    if (connectorChecks.some((c) => c.status === DoctorStatus.Fail)) {
      throw new Error(`connector preflight failed: ${connectorChecks.filter((c) => c.status === DoctorStatus.Fail).map((c) => c.detail).join(' | ')}`);
    }
    progress.update(`executing query via ${plugin.manifest.name}`);
    const executeStart = Date.now();
    const pluginParams: BuiltinPluginParams = {};
    if (opts.proto) pluginParams.protoMessage = String(opts.proto);
    if (opts.protoRoot) pluginParams.protoRoot = String(opts.protoRoot);
    if (opts.allowFlush) pluginParams.allowFlush = true;
    if (opts.requestJson) pluginParams.requestJson = String(opts.requestJson);
    if (opts.skipProtoValidate) pluginParams.skipProtoValidate = true;
    if (datasource.kind === DatasourceKind.Grpc && params && Object.keys(params).length) {
      pluginParams.params = params;
    }
    let result;
    try {
      result = await withQueryTimeout({
        timeoutMs,
        run: () =>
          execute(
            {
              datasource,
              query: executedQuery,
              capability: capability as any,
              timeoutMs,
              sessionTimeZone,
              pluginParams: Object.keys(pluginParams).length ? pluginParams : undefined,
            },
            creds,
          ),
      });
    } catch (err) {
      const message = (err as Error).message || '';
      const code = classifyError(message);
      const canPromptPassword =
        code === 'ACCESS_DENIED' &&
        !creds.password &&
        !ctx.jsonMode &&
        input.isTTY &&
        !process.env.CI &&
        (datasource.kind === DatasourceKind.Mysql || datasource.kind === DatasourceKind.Postgres);
      if (!canPromptPassword) throw err;
      progress.update(`password required for ${datasource.credentialRef}`);
      progress.stop();
      const password = await promptPassword(datasource.credentialRef);
      if (!password) throw err;
      creds = { ...creds, password };
      await ctx.credentialStore.set(datasource.credentialRef, creds);
      progress.update('retrying query');
      result = await withQueryTimeout({
        timeoutMs,
        run: () =>
          execute(
            {
              datasource,
              query: executedQuery,
              capability: capability as any,
              timeoutMs,
              sessionTimeZone,
              pluginParams: Object.keys(pluginParams).length ? pluginParams : undefined,
            },
            creds,
          ),
      });
    }
    phaseExecuteMs = Date.now() - executeStart;
    logVerbose(`phase execute: ${phaseExecuteMs}ms`);
    result.runId = artifacts.runId;
    if (warnings.length) result.warnings = [...result.warnings, ...warnings];
    result.timings = {
      ...result.timings,
      phases: {
        resolveMs: phaseResolveMs,
        connectMs: phaseConnectMs,
        executeMs: phaseExecuteMs,
        totalMs: Date.now() - phaseStart,
      },
    };
    result.resolved = {
      source: resolutionSource,
      env,
      namespace: datasource.namespace || namespace || undefined,
      service,
      accessMethod: str(ctx.kbStore.resolveConnection(service, env, namespace || undefined)?.access_method),
      target: str(datasource.connection.target),
      database: str(datasource.connection.database),
      engine: datasource.kind,
    };
    const pluginMeta = result.meta || {};
    const pluginSchema = pluginMeta.schemaContext;
    const mergedSchema = pluginSchema
      ? {
          ...schemaContext,
          ...pluginSchema,
          tables: { ...(schemaContext.tables || {}), ...(pluginSchema.tables || {}) },
        }
      : schemaContext;
    result.meta = { ...pluginMeta, schemaContext: mergedSchema, queryMemory };
    appendRunsLedgerEntry(
      ledgerInputFromResult({
        ledgerDir: ctx.paths.runsLedgerDir,
        result,
        datasource,
        intent: effectiveIntent,
        reason,
        sql: query,
        tables: referencedTables,
        redactionTier: ctx.runtimeConfigStore.ledgerRedactionTier(env || datasource.env),
      }),
    );
    writeRunSummary(artifacts.runDir, result);
    appendEvent(artifacts.runDir, 'query succeeded');

    ctx.learningStore.saveSuccess({ datasource, sql: query });
    const phaseSummary = ctx.verbose
      ? ` [resolve ${phaseResolveMs}ms · connect ${phaseConnectMs}ms · execute ${phaseExecuteMs}ms]`
      : '';
    progress.succeed(`query complete (${result.result.rows.length} rows, ${result.timings.durationMs}ms)${phaseSummary}`);

    const presented = jsonExtractSpecs.length
      ? applyJsonExtract(result.result.columns || [], result.result.rows, jsonExtractSpecs)
      : { columns: result.result.columns || [], rows: result.result.rows };
    if (ctx.jsonMode) {
      const cols = presented.columns;
      const rowsObject = Boolean(opts.rowsObject);
      const data: Record<string, unknown> = {
        columns: cols,
        rows: rowsObject
          ? presented.rows
          : presented.rows.map((row) => cols.map((col) => (row as Record<string, unknown>)[col] ?? null)),
        datasource: datasource.name,
        plugin: result.plugin,
        classification: result.classification,
      };
      if (!rowsObject) data.rowsForm = 'array';
      if (Array.isArray(result.warnings) && result.warnings.length) data.warnings = result.warnings;
      const meta: Record<string, unknown> = {
        ...(result.meta || {}),
        runId: result.runId,
        resolved: result.resolved,
        phases: result.timings.phases,
        timings: { durationMs: result.timings.durationMs },
        requestId: randomUUID(),
      };
      const envelope = trimQueryJsonEnvelope({ ok: true, data, meta });
      printJsonPluck(envelope, opts.pluck ? String(opts.pluck) : undefined);
    } else {
      console.log(`resolved via=${resolutionSource} env=${env || ''} service=${service || ''} engine=${datasource.kind} target=${str(datasource.connection.target)} database=${str(datasource.connection.database)}`);
      console.log(renderTableSmart(presented.rows.map((r) => rowFromArray(presented.columns, r)), { full: Boolean(opts.full) }));
      const directFooter = renderSchemaContextFooter(result.meta?.schemaContext);
      if (directFooter) console.log(directFooter);
      const renderedMemory = renderQueryMemoryTty(queryMemory);
      if (renderedMemory) console.log(renderedMemory);
    }
  } catch (error) {
    const message = (error as Error).message;
    const code = classifyError(message);
    appendEvent(artifacts.runDir, `query failed code=${code} message=${message}`);
    progress.fail(`query failed (${code})`);
    ctx.learningStore.saveFailure(datasource);
    appendRunsLedgerEntry({
      ledgerDir: ctx.paths.runsLedgerDir,
      runId: artifacts.runId,
      datasource,
      intent: effectiveIntent,
      reason,
      sql: query,
      tables: referencedTables,
      capability: capability as any,
      outcomeCode: code,
      errorClass: code,
      redactionTier: ctx.runtimeConfigStore.ledgerRedactionTier(env || datasource.env),
    });
    const wrapped = new Error(message.startsWith(`${code}:`) ? message : `${code}: ${message}`);
    (wrapped as Error & { details?: unknown }).details = (error as Error & { details?: unknown }).details;
    (wrapped as Error & { meta?: Record<string, unknown> }).meta = { runId: artifacts.runId, schemaContext, queryMemory };
    throw wrapped;
  }
}
