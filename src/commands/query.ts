import { Command } from 'commander';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import type { AppContext } from '../core/app.js';
import { classifyError, defaultDatasourceName, environmentPolicy, fillTemplate, normalizeNamespace, normalizeService, parseParamPairs, runDatasourceConnectors } from '../core/app.js';
import { criticalDatasourceKbConflicts, datasourceKbConflicts } from '../core/conflicts.js';
import { discoverKubernetesTargets, discoverTeleportTargets, inferDatabaseCandidates } from '../core/discovery.js';
import { exitCodeForClass } from '../core/exit-codes.js';
import { createRunArtifacts, writeRunSummary, appendEvent } from '../core/artifacts.js';
import { bootstrapDatasource, saveKbBootstrapCandidate } from '../core/bootstrap.js';
import { printJson, printJsonPluck, renderTableSmart } from '../core/output.js';
import { createProgress } from '../core/progress.js';
import { enforceMutationPolicy, enforcePartitionPredicate, enforceSchemaIntrospectionPolicy } from '../core/safety.js';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { parseTimeoutMs, withQueryTimeout } from '../core/query-timeout.js';
import { ensureStarterRuntime } from '../core/runtime-init.js';
import { rpcCall } from '../daemon/client.js';
import { ensureSchemaSnapshot } from './learn.js';
import { supportsSchemaRefresh } from '../core/schema-refresh.js';
import { buildSchemaContext, collectReferencedTables } from '../core/schema-context.js';
import { appendRunsLedgerEntry, ledgerInputFromResult } from '../core/runs-ledger.js';
import { buildQueryMemory, renderQueryMemoryTty, resolveReason } from '../core/query-memory.js';
import type { QueryCard } from '../types/cards.js';

function rowFromArray(columns: string[], row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const c of columns) out[c] = row[c];
  return out;
}

function parseDatasourceAlias(value: string | undefined, aliases: Record<string, string>): { env: string; service: string } | null {
  const raw = String(value || '').trim().toLowerCase();
  const m = raw.match(/^([a-z0-9]+)-([a-z0-9-]+)$/);
  if (!m) return null;
  return { env: m[1], service: normalizeService(m[2], aliases) };
}

function cardParamNames(card: QueryCard): string[] {
  return (card.params || []).map((param) => param.name).filter(Boolean);
}

function preferredAccessMethods(ctx: AppContext, env: string, kbAccessMethod?: string): string[] {
  const policy = environmentPolicy(ctx, env);
  const out = [...policy.preferredAccessMethods];
  if (kbAccessMethod && !out.includes(kbAccessMethod)) out.push(kbAccessMethod);
  return out.filter(Boolean);
}

function discoverTargets(ctx: AppContext, input: { env: string; service: string; accessMethods: string[]; namespace?: string }): string[] {
  const policy = environmentPolicy(ctx, input.env);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const method of input.accessMethods) {
    const current = String(method || '').trim().toLowerCase();
    let next: string[] = [];
    if (current === 'qa-portforward') {
      next = discoverKubernetesTargets(String(input.namespace || 'default'), input.service, input.env, policy);
    } else if (current === 'tsh') {
      next = discoverTeleportTargets(input.service, input.env, policy);
    }
    for (const target of next) {
      if (seen.has(target)) continue;
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}

function misconfiguredDatasourceError(datasourceName: string, env: string, service: string, conflicts: string[]): Error {
  return new Error(
    `MISCONFIGURED_DATASOURCE: datasource '${datasourceName}' conflicts with KB for env=${env} service=${service} (${conflicts.join('; ')}). Datasource store blocks KB-backed execution until the profile is repaired.`,
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

export function registerQuery(program: Command, getCtx: () => AppContext): void {
  program
    .command('query')
    .description('Execute plugin-native query against resolved datasource')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--namespace <namespace>')
    .option('--service <service>')
    .option('--intent <intent>')
    .option('--reason <reason>')
    .option('--card <id>')
    .option('--template <id>')
    .option('--query <native>')
    .option('--param <key=value>', 'repeatable', (v, p: string[]) => (p || []).concat(v), [])
    .option('--allow-discovery', 'fall back to probing kubectl/teleport targets when no profile or KB entry resolves the env+service. Off by default for reproducibility.', false)
    .option('--allow-mutate', 'allow mutating query', false)
    .option('--allow-partition-scan', 'allow querying RANGE/LIST partitioned tables without partition predicates', false)
    .option('--allow-schema-introspection', 'allow SHOW CREATE/DESCRIBE/SHOW COLUMNS even when the service schema is already cached', false)
    .option('--explain', 'wrap query with EXPLAIN; reports the plan instead of running the query', false)
    .option('--full', 'render full result table even when result is large (skip auto-summary)', false)
    .option('--rows-object', 'emit rows as objects keyed by column name (legacy). Default JSON output uses compact array form paired with the columns array.', false)
    .option('--pluck <path>', 'return only the subtree at this dot-path of the JSON envelope (e.g. result.rows, meta.schemaContext, error.details). Full record is still persisted to ~/.taproot/runs/<runId>/summary.json — use "taproot --json run show --run-id <id> --pluck <other-path>" to fetch other fields later.')
    .option('--proto <Message>', 'decode binary reply payloads as the given protobuf message (e.g. OrderProto). Used by the redis plugin; requires --proto-root or a datasource-level default in resolverHints.protoRoot.')
    .option('--proto-root <dir>', 'directory containing .proto sources used for decoding. Loaded recursively. Defaults to resolverHints.protoRoot on the datasource if set.')
    .option('--allow-flush', 'permit Redis FLUSH-tier commands (FLUSHDB/FLUSHALL/SWAPDB/MIGRATE). Required in addition to --allow-mutate. Off by default.', false)
    .option('--request-json <json>', 'gRPC plugin: request message body as JSON. Overrides --param-built payloads. Example: \'{"values":[1,2,3]}\'.')
    .option(
      '--timeout-ms <ms>',
      `abort queries that run longer than this (default ${RUNTIME_CONSTANTS.query.defaultTimeoutMs})`,
      String(RUNTIME_CONSTANTS.query.defaultTimeoutMs),
    )
    .action(async (opts) => {
      const ctx = getCtx();
      ensureStarterRuntime(ctx);
      const timeoutMs = parseTimeoutMs(opts.timeoutMs, RUNTIME_CONSTANTS.query.defaultTimeoutMs);
      const aliases = ctx.runtimeConfigStore.serviceAliases();
      const explicitProfile = opts.datasource ? ctx.datasourceStore.get(opts.datasource) : undefined;
      const alias = explicitProfile ? null : parseDatasourceAlias(opts.datasource, aliases);
      const env = String(opts.env || explicitProfile?.env || alias?.env || '').trim();
      const namespace = normalizeNamespace(String(opts.namespace || explicitProfile?.namespace || ''));
      const policy = environmentPolicy(ctx, env);
      const allowDiscovery = Boolean(opts.allowDiscovery) || policy.allowDiscoveryByDefault;
      const progress = createProgress({
        enabled: !ctx.jsonMode && !ctx.verbose,
        noAnimations: ctx.noAnimations,
        noColor: ctx.noColor,
        verbose: ctx.verbose,
        plainUpdates: !ctx.jsonMode && process.stderr.isTTY,
      });
      const logVerbose = (msg: string): void => {
        if (!ctx.jsonMode && ctx.verbose) process.stderr.write(`[taproot] ${msg}\n`);
      };
      const forceDirect = process.env.TAPROOT_FORCE_DIRECT === '1' || allowDiscovery || Boolean(opts.explain);
      if (opts.explain && !opts.query) {
        throw new Error('Invalid argument: --explain requires --query (raw SQL). Resolve --card/--template/--intent first, then re-run with --query and --explain.');
      }
      try {
        if (allowDiscovery && !ctx.jsonMode) {
          progress.update('discovery mode enabled, bypassing daemon');
        }
        progress.update(forceDirect ? 'running direct query mode' : 'attempting daemon query path');
        if (!forceDirect) {
          try {
            const rpc = await rpcCall({
              timeoutMs: Math.max(RUNTIME_CONSTANTS.rpc.requestTimeoutMs, timeoutMs + 1000),
              method: 'query.execute',
              params: {
                datasource: opts.datasource,
                env: opts.env,
                service: opts.service,
                namespace: opts.namespace,
                intent: opts.intent,
                reason: opts.reason,
                card: opts.card,
                template: opts.template,
                query: opts.query,
                allowDiscovery,
                allowMutate: Boolean(opts.allowMutate),
                allowPartitionScan: Boolean(opts.allowPartitionScan),
                allowSchemaIntrospection: Boolean(opts.allowSchemaIntrospection),
                rowsObject: Boolean(opts.rowsObject),
                timeoutMs,
                param: opts.param || [],
                proto: opts.proto,
                protoRoot: opts.protoRoot,
                allowFlush: Boolean(opts.allowFlush),
                requestJson: opts.requestJson,
              },
            });
            if (rpc.ok) {
              const columns = (rpc.data?.columns as string[]) || [];
              const rows = (rpc.data?.rows as Array<Record<string, unknown>>) || [];
              const warnings = (rpc.data?.warnings as string[]) || [];
              if (ctx.jsonMode) {
                printJson({
                  ok: true,
                  data: rpc.data || {},
                  meta: { ...(rpc.meta || {}), requestId: rpc.requestId },
                });
              } else {
                progress.succeed(`query complete (${rows.length} rows)`);
                if (warnings.length) {
                  progress.warn(`warnings: ${warnings.join(' | ')}`);
                }
                logVerbose(
                  `daemon request=${rpc.requestId} session=${rpc.meta?.sessionId || 'n/a'} run=${rpc.meta?.runId || 'n/a'}`,
                );
                console.log(renderTableSmart(rows.map((r) => rowFromArray(columns, r)), { full: Boolean(opts.full) }));
                const daemonSchemaContext = (rpc.data as any)?.meta?.schemaContext || (rpc.meta as any)?.schemaContext;
                const daemonSchemaCount = daemonSchemaContext?.tables ? Object.keys(daemonSchemaContext.tables).length : 0;
                if (daemonSchemaCount) {
                  console.log(`[schemaContext: ${daemonSchemaCount} table${daemonSchemaCount === 1 ? '' : 's'} cached — pass --json for full detail]`);
                }
                const renderedMemory = renderQueryMemoryTty(rpc.meta?.queryMemory || (rpc.data?.queryMemory as any));
                if (renderedMemory) console.log(renderedMemory);
              }
              return;
            }
            const code = rpc.error?.code || 'GENERIC';
            const message = rpc.error?.message || 'daemon query failed';
            if (ctx.jsonMode) {
              printJson({
                ok: false,
                error: { code, message, details: rpc.error?.details },
                meta: { ...(rpc.meta || {}), requestId: rpc.requestId },
              });
              process.exitCode = exitCodeForClass(code);
              return;
            }
            throw new Error(`${code}: ${message}`);
          } catch (error) {
            const msg = String((error as Error).message || '');
            if (!/(ENOENT|ECONNREFUSED|EPIPE|socket hang up)/i.test(msg)) {
              progress.fail('daemon query failed');
              throw error;
            }
            progress.update('daemon unavailable, falling back to direct mode');
            logVerbose(`daemon RPC unavailable (${msg})`);
          }
        }
      const phaseStart = Date.now();
      let phaseResolveMs = 0;
      let phaseConnectMs = 0;
      let phaseExecuteMs = 0;
      let datasource = opts.datasource ? ctx.datasourceStore.get(opts.datasource) : undefined;
      const service = normalizeService(opts.service || explicitProfile?.service || alias?.service || '', aliases);
      progress.update(`resolving datasource (${opts.datasource || `${env}-${service || 'unknown'}`})`);
      let resolutionSource: 'explicit' | 'store' | 'learning' | 'kb' | 'unknown' = datasource ? 'explicit' : 'unknown';
      const deterministicRequired = policy.deterministicRequired;
      if (!datasource && opts.env && service) {
        datasource = ctx.datasourceStore.resolveByEnvService(opts.env, service, namespace || undefined);
        if (datasource) resolutionSource = 'store';
      }
      if (!datasource && env && service) {
        datasource = ctx.datasourceStore.resolveByEnvService(env, service, namespace || undefined);
        if (datasource) resolutionSource = 'store';
      }
      if (!datasource && env && service && (!deterministicRequired || allowDiscovery)) {
        const learned = ctx.learningStore.resolveConnection(env, service, namespace || undefined);
        if (learned) {
          datasource = ctx.datasourceStore.save({
            name: learned.datasourceName,
            kind: learned.kind,
            env: learned.env,
            namespace: learned.namespace,
            service: learned.service,
            tags: ['learning-derived'],
            connection: learned.connection,
            credentialRef: learned.credentialRef,
            connectors: learned.connectors,
            policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
            resolverHints: learned.resolverHints || {},
            updatedAt: new Date().toISOString(),
            confidence: learned.confidence,
          } as any);
          resolutionSource = 'learning';
        }
      }
      if (!datasource && env && service) {
        datasource = (await bootstrapDatasource(ctx, env, service, opts.datasource || defaultDatasourceName(env, service, namespace || undefined), namespace || undefined))?.profile;
        if (datasource) {
          resolutionSource = 'kb';
          logVerbose(`auto-bootstrapped datasource from KB (${datasource.name})`);
        }
      }
      if (!datasource && env && service && allowDiscovery) {
        const kb = ctx.kbStore.resolveConnection(service, env, namespace || undefined);
        const kbAccessMethod = String(kb?.access_method || '').trim().toLowerCase();
        const targetNamespace = String(kb?.namespace || namespace || 'default');
        const accessMethods = preferredAccessMethods(ctx, env, kbAccessMethod);
        const targets = discoverTargets(ctx, { env, service, accessMethods, namespace: targetNamespace });
        if (targets.length) {
          const target = targets[0];
          const engine = policy.targetPreference.find((item) => target.toLowerCase().includes(item.toLowerCase())) || (String(kb?.engine || 'mysql').toLowerCase().includes('postgres') ? 'postgres' : 'mysql');
          const database = String(kb?.database || inferDatabaseCandidates(service)[0] || '');
          const dbUser = String(kb?.db_user || '');
          const accessMethod = accessMethods[0] || kbAccessMethod;
          const syntheticKb = {
            access_method: accessMethod,
            engine,
            database,
            db_user: dbUser,
            target,
            namespace: targetNamespace,
            ...(kb || {}),
          };
          if (accessMethod === 'tsh') {
            datasource = await saveKbBootstrapCandidate(ctx, env, service, opts.datasource || defaultDatasourceName(env, service, targetNamespace), syntheticKb, {
              targetOverride: target,
              tags: ['discovery-derived'],
              confidence: 0.6,
            });
            resolutionSource = 'kb';
          } else if (accessMethod === 'qa-portforward') {
            datasource = await saveKbBootstrapCandidate(ctx, env, service, opts.datasource || defaultDatasourceName(env, service, targetNamespace), syntheticKb, {
              targetOverride: target,
              tags: ['discovery-derived'],
              confidence: 0.6,
            });
            resolutionSource = 'kb';
          }
        }
      }
      if (!datasource && deterministicRequired && !allowDiscovery) {
        throw new Error(`DETERMINISTIC_REQUIRED: environment '${env || 'unknown'}' requires deterministic datasource resolution from profile or KB. Use --datasource or --env+--service.`);
      }
      if (!datasource) throw new Error('Datasource resolution failed. Use --datasource or --env+--service.');
      if (deterministicRequired && !allowDiscovery && resolutionSource === 'learning') {
        throw new Error(`DETERMINISTIC_REQUIRED: environment '${env || 'unknown'}' requires KB/profile-backed datasource resolution. Retry without discovery cache or enable discovery in config or CLI.`);
      }
      const warnings: string[] = [];
      if (env && service) {
        const kb = ctx.kbStore.resolveConnection(service, env, namespace || undefined);
        if (kb) {
          const critical = criticalDatasourceKbConflicts(datasource as any, kb);
          if (critical.length) {
            throw misconfiguredDatasourceError(datasource.name, env, service, critical);
          }
          const conflicts = datasourceKbConflicts(datasource as any, kb);
          if (conflicts.length) {
            const warning = `datasource overrides KB (${conflicts.join('; ')})`;
            warnings.push(warning);
            logVerbose(`warning: ${warning}`);
          }
        }
      }
      phaseResolveMs = Date.now() - phaseStart;
      progress.update(`datasource ready (${datasource.name})`);
      logVerbose(`phase resolve: ${phaseResolveMs}ms`);

      const params = parseParamPairs(opts.param || []);
      let selectedCard: QueryCard | undefined;
      let query = (opts.query || '').trim();
      if (opts.card) {
        selectedCard = ctx.cardStore.get(opts.card);
        if (!selectedCard) throw new Error(`Query card not found: ${opts.card}`);
        const allowedParams = cardParamNames(selectedCard);
        if (allowedParams.length) {
          const unknownParams = Object.keys(params).filter((key) => !allowedParams.includes(key));
          if (unknownParams.length) throw new Error(`Invalid argument: Unknown --param for card ${selectedCard.id}: ${unknownParams.join(', ')}`);
        }
        if (!query) query = fillTemplate(selectedCard.sql, params);
      }
      if (!query && opts.template) {
        const tpl = ctx.templateStore.get(opts.template);
        if (!tpl) throw new Error(`Template not found: ${opts.template}`);
        query = fillTemplate(tpl.nativeQueryTemplate, params);
      }
      const effectiveIntent = opts.intent || selectedCard?.intent || '';
      if (!query && effectiveIntent) {
        const learned = ctx.learningStore.resolveQueryTemplate(service || datasource.service || '', effectiveIntent);
        const tpl =
          (learned ? { nativeQueryTemplate: learned.sqlTemplate } : null) ||
          ctx.kbStore.resolveQuery(service || datasource.service || '', effectiveIntent) ||
          ctx.templateStore.resolveByIntent({ datasourceName: datasource.name, datasourceKind: datasource.kind, intent: effectiveIntent });
        if (tpl) query = fillTemplate(String((tpl as any).nativeQueryTemplate), params);
      }
      if (!query) throw new Error('No query resolved. Provide --query, --template, or --intent.');
      progress.update('query resolved');

      const referencedTables = collectReferencedTables(query);
      if (supportsSchemaRefresh(datasource as any) && referencedTables.length) {
        const priorSnapshotRows = ctx.learningStore.schemaTables(datasource.service).length;
        if (priorSnapshotRows === 0 && !ctx.jsonMode) {
          process.stderr.write(`[taproot] first query against service ${datasource.service} — running one-time schema learn for ${referencedTables.join(', ')}\n`);
        }
        try {
          await ensureSchemaSnapshot(ctx, {
            datasource: datasource.name,
            tables: referencedTables,
            metadataTimeoutMs: 3000,
          });
        } catch (err) {
          logVerbose(`schema prime skipped: ${(err as Error).message}`);
        }
      }
      const schemaContext = buildSchemaContext(query, { service: datasource.service }, ctx.learningStore);
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
        cardStore: ctx.cardStore,
        selectedCard,
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
        enforceMutationPolicy({ sql: query, allowMutate: Boolean(opts.allowMutate), datasource: datasource as any });
        {
          const cachedRows = ctx.learningStore.schemaTables(datasource.service);
          const hasRefreshedSchema = cachedRows.some((row) => row.sources.includes('refreshed-metadata') || row.sources.includes('manual'));
          warnings.push(
            ...enforceSchemaIntrospectionPolicy({
              sql: query,
              service: String(datasource.service || ''),
              hasRefreshedSchema,
              allowSchemaIntrospection: Boolean(opts.allowSchemaIntrospection),
            }),
          );
        }
        warnings.push(
          ...enforcePartitionPredicate({
            sql: query,
            schemaContext,
            allowPartitionScan: Boolean(opts.allowPartitionScan),
          }),
        );
        const executedQuery = opts.explain ? `EXPLAIN ${query}` : query;
        progress.update('checking connectors');
        const connectStart = Date.now();
        const preflightBudgetMs = Math.max(timeoutMs, RUNTIME_CONSTANTS.connector.preflightTimeoutMs);
        const connectorChecks = await withQueryTimeout({
          timeoutMs: preflightBudgetMs,
          run: () =>
            runDatasourceConnectors({
              datasource: datasource as any,
              credentialStore: ctx.credentialStore,
              pluginRegistry: ctx.pluginRegistry,
              mode: 'connect',
            }),
        });
        phaseConnectMs = Date.now() - connectStart;
        logVerbose(`phase connect: ${phaseConnectMs}ms`);
        for (const c of connectorChecks) appendEvent(artifacts.runDir, `connector ${c.check} ${c.status}: ${c.detail}`);
        for (const c of connectorChecks) logVerbose(`connector ${c.check}: ${c.status}`);
        if (connectorChecks.some((c) => c.status === 'fail')) {
          throw new Error(`connector preflight failed: ${connectorChecks.filter((c) => c.status === 'fail').map((c) => c.detail).join(' | ')}`);
        }
        progress.update(`executing query via ${plugin.manifest.name}`);
        const executeStart = Date.now();
        const pluginParams: Record<string, unknown> = {};
        if (opts.proto) pluginParams.protoMessage = String(opts.proto);
        if (opts.protoRoot) pluginParams.protoRoot = String(opts.protoRoot);
        if (opts.allowFlush) pluginParams.allowFlush = true;
        if (opts.requestJson) pluginParams.requestJson = String(opts.requestJson);
        if (datasource.kind === 'grpc' && params && Object.keys(params).length) {
          pluginParams.params = params;
        }
        let result;
        try {
          result = await withQueryTimeout({
            timeoutMs,
            run: () =>
              execute(
                {
                  datasource: datasource as any,
                  query: executedQuery,
                  capability: capability as any,
                  timeoutMs,
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
            (datasource.kind === 'mysql' || datasource.kind === 'postgres');
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
                  datasource: datasource as any,
                  query: executedQuery,
                  capability: capability as any,
                  timeoutMs,
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
          accessMethod: String(ctx.kbStore.resolveConnection(service, env, namespace || undefined)?.access_method || ''),
          target: String(datasource.connection.target || ''),
          database: String(datasource.connection.database || ''),
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
            datasource: datasource as any,
            intent: effectiveIntent,
            reason,
            sql: query,
            tables: referencedTables,
            redactionTier: ctx.runtimeConfigStore.ledgerRedactionTier(env || datasource.env),
          }),
        );
        writeRunSummary(artifacts.runDir, result);
        appendEvent(artifacts.runDir, 'query succeeded');

        ctx.learningStore.saveSuccess({ datasource: datasource as any, queryIntent: effectiveIntent, sql: query, result });
        const phaseSummary = ctx.verbose
          ? ` [resolve ${phaseResolveMs}ms · connect ${phaseConnectMs}ms · execute ${phaseExecuteMs}ms]`
          : '';
        progress.succeed(`query complete (${result.result.rows.length} rows, ${result.timings.durationMs}ms)${phaseSummary}`);

        if (ctx.jsonMode) {
          const trimmedTimings: Record<string, unknown> = { durationMs: result.timings.durationMs };
          if (result.timings.phases) trimmedTimings.phases = result.timings.phases;
          const trimmed: Record<string, unknown> = {
            ...result,
            query: undefined,
            timings: trimmedTimings,
          };
          if (!Boolean(opts.rowsObject)) {
            const cols = result.result.columns || [];
            trimmed.result = {
              columns: cols,
              rows: result.result.rows.map((row) => cols.map((col) => (row as Record<string, unknown>)[col] ?? null)),
              rowsForm: 'array',
            };
          }
          if (Array.isArray(result.warnings) && result.warnings.length === 0) delete trimmed.warnings;
          if (trimmed.meta && typeof trimmed.meta === 'object') {
            const meta = trimmed.meta as Record<string, unknown>;
            const qm = meta.queryMemory as Record<string, unknown> | undefined;
            if (qm && Object.keys(qm).length === 0) delete meta.queryMemory;
            const sc = meta.schemaContext as {
              tables?: Record<string, unknown>;
              services?: Record<string, unknown>;
              messages?: Record<string, unknown>;
              enums?: Record<string, unknown>;
            } | undefined;
            if (
              sc &&
              !Object.keys(sc.tables || {}).length &&
              !Object.keys(sc.services || {}).length &&
              !Object.keys(sc.messages || {}).length &&
              !Object.keys(sc.enums || {}).length
            ) delete meta.schemaContext;
          }
          printJsonPluck(trimmed, opts.pluck ? String(opts.pluck) : undefined);
        }
        else {
          console.log(`resolved via=${resolutionSource} env=${env || ''} service=${service || ''} engine=${datasource.kind} target=${String(datasource.connection.target || '')} database=${String(datasource.connection.database || '')}`);
          console.log(renderTableSmart(result.result.rows.map((r) => rowFromArray(result.result.columns, r)), { full: Boolean(opts.full) }));
          const finalSchema = (result.meta?.schemaContext as { tables?: Record<string, unknown>; services?: Record<string, unknown>; messages?: Record<string, unknown> } | undefined);
          const schemaTableCount = Object.keys(finalSchema?.tables || {}).length;
          const schemaServiceCount = Object.keys(finalSchema?.services || {}).length;
          const schemaMessageCount = Object.keys(finalSchema?.messages || {}).length;
          if (schemaTableCount) {
            console.log(`[schemaContext: ${schemaTableCount} table${schemaTableCount === 1 ? '' : 's'} cached — pass --json for full detail]`);
          } else if (schemaServiceCount || schemaMessageCount) {
            console.log(`[schemaContext: ${schemaServiceCount} service${schemaServiceCount === 1 ? '' : 's'}, ${schemaMessageCount} message${schemaMessageCount === 1 ? '' : 's'} — pass --json for full detail]`);
          }
          const renderedMemory = renderQueryMemoryTty(queryMemory);
          if (renderedMemory) console.log(renderedMemory);
        }
        } catch (error) {
          const message = (error as Error).message;
          const code = classifyError(message);
          appendEvent(artifacts.runDir, `query failed code=${code} message=${message}`);
          progress.fail(`query failed (${code})`);
          ctx.learningStore.saveFailure({
            datasource: datasource as any,
            queryIntent: effectiveIntent,
            sql: query,
            errorClass: code,
          });
          appendRunsLedgerEntry({
            ledgerDir: ctx.paths.runsLedgerDir,
            runId: artifacts.runId,
            datasource: datasource as any,
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
      } finally {
        progress.stop();
      }
    });
}
