import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import type { AppContext } from '../core/app.js';
import { buildContext, classifyError, environmentPolicy, fillTemplate, nextAction, normalizeNamespace, normalizeService, parseParamPairs, runDatasourceConnectors } from '../core/app.js';
import { appendEvent, createRunArtifacts, writeRunSummary } from '../core/artifacts.js';
import { criticalDatasourceKbConflicts, datasourceKbConflicts } from '../core/conflicts.js';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { registerCleanup, runRegisteredCleanup } from '../core/cleanup.js';
import { enforceMutationPolicy, enforcePartitionPredicate, enforceSchemaIntrospectionPolicy } from '../core/safety.js';
import { nowIso } from '../core/time.js';
import { deterministicRequired, discoveryUnavailable, misconfiguredDatasource } from '../core/error-classification.js';
import { parseTimeoutMs, queryTimeoutError, withQueryTimeout } from '../core/query-timeout.js';
import { resolveCanonicalDatasource } from '../core/resolve-datasource.js';
import { DatasourceKind, DoctorStatus } from '../types/core.js';
import type { DatasourceProfile, QueryResult, SchemaContext } from '../types/core.js';
import type { BuiltinPluginParams } from '../types/plugin-params.js';
import { RpcMethod, type RpcRequest, type RpcResponse } from './types.js';
import { QueryLimiter } from './query-limiter.js';
import { SessionRegistry } from './session-registry.js';
import { closeAllTeleportMysqlProxies, closeTeleportMysqlSessionProxies } from '../plugins-builtins/teleport-mysql/index.js';
import { ensureSchemaSnapshot } from '../commands/learn.js';
import { supportsSchemaRefresh } from '../core/schema-refresh.js';
import { buildSchemaContext, collectReferencedTables } from '../core/schema-context.js';
import { liveColumnsFromSchemaContext } from '../core/relations.js';
import { appendRunsLedgerEntry, ledgerInputFromResult } from '../core/runs-ledger.js';
import { buildQueryMemory, resolveReason } from '../core/query-memory.js';
import type { QueryCard } from '../types/cards.js';

export interface DaemonOptions {
  stateRoot?: string;
  socketPath?: string;
}

function defaultRunDir(stateRoot?: string): string {
  return path.join(stateRoot || process.env.TAPROOT_STATE_ROOT || path.join(os.homedir(), '.taproot'), 'run');
}

function responseBase(req: RpcRequest): RpcResponse {
  return {
    protocolVersion: RUNTIME_CONSTANTS.protocolVersion,
    requestId: req.requestId,
    ok: false,
    meta: {},
  };
}

function parseLine(line: string): RpcRequest {
  const parsed = JSON.parse(line) as RpcRequest;
  if (parsed.protocolVersion !== RUNTIME_CONSTANTS.protocolVersion) {
    throw new Error(`Unsupported protocolVersion=${parsed.protocolVersion}`);
  }
  if (!parsed.requestId || !parsed.method || typeof parsed.params !== 'object') {
    throw new Error('Invalid RPC request envelope');
  }
  return parsed;
}

function parseQueryParams(params: Record<string, unknown>): Record<string, string> {
  if (Array.isArray(params.param)) return parseParamPairs(params.param.map((v) => String(v)));
  if (params.params && typeof params.params === 'object') {
    return Object.fromEntries(Object.entries(params.params as Record<string, unknown>).map(([k, v]) => [k, String(v)]));
  }
  return {};
}

function cardParamNames(card: QueryCard): string[] {
  return (card.params || []).map((param) => param.name).filter(Boolean);
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
    accessMethod: String(ctx.kbStore.resolveConnection(service, env, namespace || undefined)?.access_method || ''),
    target: String(datasource.connection.target || ''),
    database: String(datasource.connection.database || ''),
    engine: datasource.kind,
  };
}

export async function startDaemon(opts: DaemonOptions = {}): Promise<{ socketPath: string; stop: () => Promise<void> }> {
  const runDir = defaultRunDir(opts.stateRoot);
  const socketPath = opts.socketPath || path.join(runDir, 'taprootd.sock');
  const lockFile = path.join(runDir, 'taprootd.pid');
  fs.mkdirSync(runDir, { recursive: true });

  if (fs.existsSync(socketPath)) fs.rmSync(socketPath, { force: true });
  if (fs.existsSync(lockFile)) fs.rmSync(lockFile, { force: true });

  const sessions = new SessionRegistry(runDir);
  const queryLimiter = new QueryLimiter(RUNTIME_CONSTANTS.daemon.maxConcurrentQueries, RUNTIME_CONSTANTS.daemon.maxQueuedQueries);
  const ctx = buildContext({ jsonMode: true });
  const startedAt = Date.now();

  const server = net.createServer((socket) => {
    let buffer = '';
    let chain = Promise.resolve();
    socket.setEncoding('utf8');

    const write = (res: RpcResponse): void => {
      socket.write(`${JSON.stringify(res)}\n`);
    };

    socket.on('data', (chunk) => {
      buffer += chunk;
      let idx = buffer.indexOf('\n');
      while (idx >= 0) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line) {
          idx = buffer.indexOf('\n');
          continue;
        }

        let req: RpcRequest;
        try {
          req = parseLine(line);
        } catch (error) {
          const res: RpcResponse = {
            protocolVersion: RUNTIME_CONSTANTS.protocolVersion,
            requestId: 'unknown',
            ok: false,
            error: { code: 'BAD_REQUEST', message: (error as Error).message },
            meta: {},
          };
          write(res);
          idx = buffer.indexOf('\n');
          continue;
        }

        chain = chain.then(async () => {
          const begin = Date.now();
          const base = responseBase(req);
          try {
            if (req.method === RpcMethod.DaemonStatus) {
              base.ok = true;
              base.data = {
                pid: process.pid,
                startedAt: new Date(startedAt).toISOString(),
                now: nowIso(),
                uptimeMs: Date.now() - startedAt,
                socketPath,
                sessions: sessions.list().length,
                queryLimiter: queryLimiter.stats(),
                limits: {
                  maxConcurrentQueries: RUNTIME_CONSTANTS.daemon.maxConcurrentQueries,
                  maxQueuedQueries: RUNTIME_CONSTANTS.daemon.maxQueuedQueries,
                  maxConcurrentLeases: RUNTIME_CONSTANTS.session.maxConcurrentLeases,
                },
              };
            } else if (req.method === RpcMethod.SessionOpen) {
              const session = sessions.open({
                datasourceName: String(req.params.datasource || req.params.datasourceName || 'unknown'),
                env: String(req.params.env || ''),
                namespace: String(req.params.namespace || ''),
                service: String(req.params.service || ''),
                kind: String(req.params.kind || ''),
                connection: (req.params.connection as Record<string, unknown>) || {},
                connectors: Array.isArray(req.params.connectors) ? (req.params.connectors as string[]) : [],
              });
              base.ok = true;
              base.data = { session };
              base.meta.sessionId = session.sessionId;
            } else if (req.method === RpcMethod.SessionList) {
              base.ok = true;
              base.data = { sessions: sessions.list() };
            } else if (req.method === RpcMethod.SessionInspect) {
              const sessionId = String(req.params.sessionId || '');
              const session = sessions.get(sessionId);
              if (!session) {
                base.ok = false;
                base.error = { code: 'NOT_FOUND', message: `Session not found: ${sessionId}` };
              } else {
                base.ok = true;
                base.data = { session };
                base.meta.sessionId = session.sessionId;
              }
            } else if (req.method === RpcMethod.SessionClose) {
              const sessionId = String(req.params.sessionId || '');
              const closed = sessions.close(sessionId);
              if (!closed) {
                base.ok = false;
                base.error = { code: 'NOT_FOUND', message: `Session not found: ${sessionId}` };
              } else {
                await closeTeleportMysqlSessionProxies(sessionId);
                base.ok = true;
                base.data = { closed: true, sessionId };
                base.meta.sessionId = sessionId;
              }
            } else if (req.method === RpcMethod.SessionCloseAll) {
              const closedCount = sessions.closeAll();
              await closeAllTeleportMysqlProxies();
              base.ok = true;
              base.data = { closedCount };
            } else if (req.method === RpcMethod.QueryExecute) {
              const phaseStart = Date.now();
              let phaseResolveMs = 0;
              let phaseConnectMs = 0;
              let phaseExecuteMs = 0;
              const allowDiscovery = Boolean(req.params.allowDiscovery);
              const rawDs = String(req.params.datasource || '').trim();
              const alias = rawDs.match(/^([a-z0-9]+)-([a-z0-9-]+)$/i);
              const env = String(req.params.env || alias?.[1] || '').trim();
              const namespace = normalizeNamespace(String(req.params.namespace || ''));
              const service = normalizeService(String(req.params.service || alias?.[2] || ''), ctx.runtimeConfigStore.serviceAliases());
              const policy = environmentPolicy(ctx, env);
              if (allowDiscovery || policy.allowDiscoveryByDefault) {
                throw discoveryUnavailable('discovery mode is only available in direct CLI mode when daemon is bypassed.');
              }
              const resolution = await resolveCanonicalDatasource({ ctx, rawDs, env, namespace, service });
              let datasource = resolution.datasource;
              const resolutionSource = resolution.source;
              if (!datasource) {
                if (policy.deterministicRequired) {
                  throw deterministicRequired(`environment '${env || 'unknown'}' requires datasource profile/KB resolution. Use --datasource or --env+--service.`);
                }
                throw new Error('Datasource resolution failed. Use --datasource or --env+--service.');
              }

              phaseResolveMs = Date.now() - phaseStart;
              const timeoutMs = parseTimeoutMs(req.params.timeoutMs, RUNTIME_CONSTANTS.query.defaultTimeoutMs);
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
                let query = String(req.params.query || '').trim();
                const params = parseQueryParams(req.params);
                let selectedCard: QueryCard | undefined;
                if (req.params.card) {
                  selectedCard = ctx.cardStore.get(String(req.params.card));
                  if (!selectedCard) throw new Error(`Query card not found: ${String(req.params.card)}`);
                  const allowedParams = cardParamNames(selectedCard);
                  if (allowedParams.length) {
                    const unknownParams = Object.keys(params).filter((key) => !allowedParams.includes(key));
                    if (unknownParams.length) throw new Error(`Invalid argument: Unknown --param for card ${selectedCard.id}: ${unknownParams.join(', ')}`);
                  }
                  if (!query) query = fillTemplate(selectedCard.sql, params);
                }
                if (!query && req.params.template) {
                  const tpl = ctx.templateStore.get(String(req.params.template));
                  if (!tpl) throw new Error(`Template not found: ${String(req.params.template)}`);
                  query = fillTemplate(tpl.nativeQueryTemplate, params);
                }
                const effectiveIntent = String(req.params.intent || selectedCard?.intent || '');
                if (!query && effectiveIntent) {
                  const intent = effectiveIntent;
                  const learned = ctx.learningStore.resolveQueryTemplate(service || datasource.service || '', intent);
                  const tpl =
                    (learned ? { nativeQueryTemplate: learned.sqlTemplate } : null) ||
                    ctx.kbStore.resolveQuery(service || datasource.service || '', intent) ||
                    ctx.templateStore.resolveByIntent({ datasourceName: datasource.name, datasourceKind: datasource.kind, intent });
                  if (tpl) query = fillTemplate(String((tpl as any).nativeQueryTemplate), params);
                }
                if (!query) throw new Error('No query resolved. Provide --query/--sql, --template, or --intent.');
                const allowMutate = Boolean(req.params.allowMutate);
                const referencedTables = collectReferencedTables(query);
                if (supportsSchemaRefresh(datasource as DatasourceProfile) && referencedTables.length) {
                  try {
                    await ensureSchemaSnapshot(ctx, {
                      datasource: datasource.name,
                      tables: referencedTables,
                      metadataTimeoutMs: 3000,
                    });
                  } catch {
                    // Query execution must not depend on metadata refresh succeeding.
                  }
                }
                const schemaContext = buildSchemaContext(query, { service: datasource.service }, ctx.learningStore);
                const relationEdges = ctx.kbStore.relationsForTables(
                  String(datasource.service || ''),
                  referencedTables,
                  liveColumnsFromSchemaContext(schemaContext.tables),
                );
                if (relationEdges.length) schemaContext.relations = relationEdges;
                const reason = resolveReason(String(req.params.reason || ''));
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
                        service: String(datasource.service || ''),
                        hasRefreshedSchema,
                        allowSchemaIntrospection: Boolean(req.params.allowSchemaIntrospection),
                      }),
                    );
                  }
                  warnings.push(
                    ...enforcePartitionPredicate({
                      sql: query,
                      schemaContext,
                      allowPartitionScan: Boolean(req.params.allowPartitionScan),
                    }),
                  );
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
                  ctx.learningStore.saveSuccess({ datasource: datasource as DatasourceProfile, queryIntent: effectiveIntent, sql: query, result });
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
                  ctx.learningStore.saveFailure({
                    datasource: datasource as DatasourceProfile,
                    queryIntent: effectiveIntent,
                    sql: query,
                    errorClass: code,
                  });
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
            } else if (req.method === RpcMethod.DaemonStop) {
              base.ok = true;
              base.data = { stopping: true };
              write({
                ...base,
                meta: { ...base.meta, timings: { durationMs: Date.now() - begin } },
              });
              socket.end();
              void runRegisteredCleanup();
              return;
            } else {
              base.ok = false;
              base.error = { code: 'UNKNOWN_METHOD', message: `Unknown RPC method: ${req.method}` };
            }
          } catch (error) {
            const message = (error as Error).message;
            const code = classifyError(message);
            base.ok = false;
            base.error = {
              code,
              message,
              details: { ...(((error as Error & { details?: Record<string, unknown> }).details) || {}), nextAction: nextAction(code) },
            };
          }

          base.meta = { ...base.meta, timings: { durationMs: Date.now() - begin } };
          write(base);
        });
        idx = buffer.indexOf('\n');
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });

  fs.writeFileSync(lockFile, `${process.pid}\n`, 'utf8');
  fs.chmodSync(socketPath, 0o600);

  const interval = setInterval(() => {
    const sweep = sessions.onTick();
    if (sweep.expiredSessionIds.length) {
      for (const sessionId of sweep.expiredSessionIds) {
        void closeTeleportMysqlSessionProxies(sessionId);
      }
    }
  }, RUNTIME_CONSTANTS.sweeper.tickMs);

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeAllTeleportMysqlProxies();
    if (fs.existsSync(socketPath)) fs.rmSync(socketPath, { force: true });
    if (fs.existsSync(lockFile)) fs.rmSync(lockFile, { force: true });
  };
  const unregisterStop = registerCleanup(`daemon-stop:${socketPath}`, stop);

  const onSignal = () => {
    void runRegisteredCleanup().finally(() => process.exit(0));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return {
    socketPath,
    stop: async () => {
      unregisterStop();
      await stop();
    },
  };
}
