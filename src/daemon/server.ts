import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { buildContext, classifyError, fillTemplate, nextAction, normalizeService, parseParamPairs, runDatasourceConnectors } from '../core/app.js';
import { appendEvent, createRunArtifacts, writeRunSummary } from '../core/artifacts.js';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { enforceMutationPolicy } from '../core/safety.js';
import { nowIso } from '../core/time.js';
import type { DatasourceProfile } from '../types/core.js';
import type { RpcRequest, RpcResponse } from './types.js';
import { SessionRegistry } from './session-registry.js';

export interface DaemonOptions {
  stateRoot?: string;
  socketPath?: string;
}

function defaultRunDir(stateRoot?: string): string {
  return path.join(stateRoot || path.join(os.homedir(), '.telequery'), 'run');
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

export async function startDaemon(opts: DaemonOptions = {}): Promise<{ socketPath: string; stop: () => Promise<void> }> {
  const runDir = defaultRunDir(opts.stateRoot);
  const socketPath = opts.socketPath || path.join(runDir, 'telequeryd.sock');
  const lockFile = path.join(runDir, 'telequeryd.pid');
  fs.mkdirSync(runDir, { recursive: true });

  if (fs.existsSync(socketPath)) fs.rmSync(socketPath, { force: true });
  if (fs.existsSync(lockFile)) fs.rmSync(lockFile, { force: true });

  const sessions = new SessionRegistry(runDir);
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
            if (req.method === 'daemon.status') {
              base.ok = true;
              base.data = {
                pid: process.pid,
                startedAt: new Date(startedAt).toISOString(),
                now: nowIso(),
                uptimeMs: Date.now() - startedAt,
                socketPath,
                sessions: sessions.list().length,
              };
            } else if (req.method === 'session.open') {
              const session = sessions.open({
                datasourceName: String(req.params.datasource || req.params.datasourceName || 'unknown'),
                env: String(req.params.env || ''),
                service: String(req.params.service || ''),
                kind: String(req.params.kind || ''),
                connection: (req.params.connection as Record<string, unknown>) || {},
                connectors: Array.isArray(req.params.connectors) ? (req.params.connectors as string[]) : [],
              });
              base.ok = true;
              base.data = { session };
              base.meta.sessionId = session.sessionId;
            } else if (req.method === 'session.list') {
              base.ok = true;
              base.data = { sessions: sessions.list() };
            } else if (req.method === 'session.inspect') {
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
            } else if (req.method === 'session.close') {
              const sessionId = String(req.params.sessionId || '');
              const closed = sessions.close(sessionId);
              if (!closed) {
                base.ok = false;
                base.error = { code: 'NOT_FOUND', message: `Session not found: ${sessionId}` };
              } else {
                base.ok = true;
                base.data = { closed: true, sessionId };
                base.meta.sessionId = sessionId;
              }
            } else if (req.method === 'session.closeAll') {
              const closedCount = sessions.closeAll();
              base.ok = true;
              base.data = { closedCount };
            } else if (req.method === 'query.execute') {
              const rawDs = String(req.params.datasource || '').trim();
              const alias = rawDs.match(/^([a-z0-9]+)-([a-z0-9-]+)$/i);
              const env = String(req.params.env || alias?.[1] || '').trim();
              const service = normalizeService(String(req.params.service || alias?.[2] || ''));
              let datasource = rawDs ? ctx.datasourceStore.get(rawDs) : undefined;
              if (!datasource && env && service) datasource = ctx.datasourceStore.resolveByEnvService(env, service);
              if (!datasource) throw new Error('Datasource resolution failed.');

              const session = sessions.open({
                datasourceName: datasource.name,
                env: datasource.env,
                service: datasource.service,
                kind: datasource.kind,
                connection: datasource.connection as Record<string, unknown>,
                connectors: datasource.connectors || [],
              });
              const leaseId = sessions.acquireLease(session.sessionId);
              base.meta.sessionId = session.sessionId;
              const heartbeat = setInterval(() => sessions.heartbeatLease(session.sessionId, leaseId), RUNTIME_CONSTANTS.session.leaseHeartbeatIntervalMs);
              try {
                let query = String(req.params.query || '').trim();
                const params = parseQueryParams(req.params);
                if (!query && req.params.template) {
                  const tpl = ctx.templateStore.get(String(req.params.template));
                  if (!tpl) throw new Error(`Template not found: ${String(req.params.template)}`);
                  query = fillTemplate(tpl.nativeQueryTemplate, params);
                }
                if (!query && req.params.intent) {
                  const intent = String(req.params.intent);
                  const learned = ctx.learningStore.resolveQueryTemplate(service || datasource.service || '', intent);
                  const tpl =
                    (learned ? { nativeQueryTemplate: learned.sqlTemplate } : null) ||
                    ctx.kbStore.resolveQuery(service || datasource.service || '', intent) ||
                    ctx.templateStore.resolveByIntent({ datasourceName: datasource.name, datasourceKind: datasource.kind, intent });
                  if (tpl) query = fillTemplate(String((tpl as any).nativeQueryTemplate), params);
                }
                if (!query) throw new Error('No query resolved.');

                const allowMutate = Boolean(req.params.allowMutate);
                enforceMutationPolicy({ sql: query, allowMutate, datasource: datasource as DatasourceProfile });
                const capability = allowMutate ? 'executeMutate' : 'executeRead';
                const plugin = ctx.pluginRegistry.get(datasource.kind);
                if (!plugin?.execute) throw new Error(`No execute plugin for '${datasource.kind}'.`);
                if (!plugin.manifest.capabilities.includes(capability as any)) throw new Error(`Plugin '${plugin.manifest.name}' does not support ${capability}.`);
                const creds = await ctx.credentialStore.get(datasource.credentialRef);
                const artifacts = createRunArtifacts(ctx.paths.runsDir, datasource.name.replace(/[^a-z0-9-]/gi, '-'));
                base.meta.runId = artifacts.runId;
                appendEvent(artifacts.runDir, `daemon query started capability=${capability} requestId=${req.requestId}`);
                const connectorChecks = await runDatasourceConnectors({
                  datasource: datasource as DatasourceProfile,
                  credentialStore: ctx.credentialStore,
                  pluginRegistry: ctx.pluginRegistry,
                  mode: 'connect',
                });
                for (const c of connectorChecks) appendEvent(artifacts.runDir, `connector ${c.check} ${c.status}: ${c.detail}`);
                if (connectorChecks.some((c) => c.status === 'fail')) {
                  throw new Error(`connector preflight failed: ${connectorChecks.filter((c) => c.status === 'fail').map((c) => c.detail).join(' | ')}`);
                }
                const result = await plugin.execute(
                  { datasource: datasource as DatasourceProfile, query, capability: capability as any },
                  creds,
                );
                result.runId = artifacts.runId;
                writeRunSummary(artifacts.runDir, result);
                appendEvent(artifacts.runDir, `daemon query succeeded requestId=${req.requestId}`);
                ctx.learningStore.saveSuccess({ datasource: datasource as DatasourceProfile, queryIntent: String(req.params.intent || ''), sql: query, result });
                base.ok = true;
                base.data = {
                  columns: result.result.columns,
                  rows: result.result.rows,
                  datasource: datasource.name,
                  plugin: result.plugin,
                  classification: result.classification,
                };
              } finally {
                clearInterval(heartbeat);
                sessions.releaseLease(session.sessionId, leaseId);
              }
            } else if (req.method === 'daemon.stop') {
              base.ok = true;
              base.data = { stopping: true };
              write({
                ...base,
                meta: { ...base.meta, timings: { durationMs: Date.now() - begin } },
              });
              socket.end();
              server.close();
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
              details: { nextAction: nextAction(code) },
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
    sessions.onTick();
  }, RUNTIME_CONSTANTS.sweeper.tickMs);

  const stop = async (): Promise<void> => {
    clearInterval(interval);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (fs.existsSync(socketPath)) fs.rmSync(socketPath, { force: true });
    if (fs.existsSync(lockFile)) fs.rmSync(lockFile, { force: true });
  };

  process.on('SIGINT', () => {
    void stop().finally(() => process.exit(0));
  });
  process.on('SIGTERM', () => {
    void stop().finally(() => process.exit(0));
  });

  return { socketPath, stop };
}
