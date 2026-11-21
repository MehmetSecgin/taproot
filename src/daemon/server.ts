import fs from 'node:fs';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import tls from 'node:tls';
import type { AppContext } from '../core/app.js';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { registerCleanup, runRegisteredCleanup } from '../core/cleanup.js';
import { badInput } from '../core/error-classification.js';
import { TAPROOT_VERSION } from '../core/version.js';
import { rpcCall } from './client.js';
import { datasourceGate, type DatasourceCheck } from './datasource-check.js';
import { refuseOtherVersion, stopForOtherVersion } from './methods/status.js';
import type { DaemonEndpoint, DaemonMethod, HandlerDeps } from './methods/types.js';
import { QueryLimiter } from './query-limiter.js';
import { MAX_REQUEST_LINE_CHARS, answerRpc, readRpcRequests, writeRpcResponse } from './rpc-connection.js';
import { SessionRegistry } from './session-registry.js';
import { mutualTlsServerOptions, readTlsMaterial, tlsFingerprint, type MutualTlsFiles } from './transport.js';
import { DAEMON_VERSION_MISMATCH, RpcMethod, type RpcRequest, type RpcResponse } from './types.js';

export type DaemonListen =
  | { kind: 'unix'; socketPath: string }
  | { kind: 'tls'; host: string; port: number; tls: MutualTlsFiles; reloadMs: number };

export type DaemonLog = (event: Record<string, unknown>) => void;

export interface DaemonInstance {
  endpoint: DaemonEndpoint;
  stop: () => Promise<void>;
}

async function claimSocket(socketPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  if (!fs.existsSync(socketPath)) return;
  const alive = await rpcCall({ socketPath, method: RpcMethod.DaemonStatus }).then((res) => res.error?.code !== DAEMON_VERSION_MISMATCH, () => false);
  if (alive) throw new Error(`taprootd already running on ${socketPath}`);
  fs.rmSync(socketPath, { force: true });
}

function endpointOf(address: string | AddressInfo): DaemonEndpoint {
  return typeof address === 'string' ? { socketPath: address } : { host: address.address, port: address.port };
}

function reloadTlsOnChange(server: tls.Server, files: MutualTlsFiles, servedFingerprint: string, intervalMs: number, log: DaemonLog): NodeJS.Timeout {
  let served = servedFingerprint;
  return setInterval(() => {
    try {
      const material = readTlsMaterial(files);
      const fingerprint = tlsFingerprint(material);
      if (fingerprint === served) return;
      server.setSecureContext(mutualTlsServerOptions(material));
      served = fingerprint;
      log({ tlsReload: 'applied' });
    } catch (error) {
      log({ tlsReload: 'failed', message: (error as Error).message });
    }
  }, intervalMs);
}

function serverFor(listen: DaemonListen, onConnection: (socket: net.Socket) => void, log: DaemonLog): { server: net.Server; watchCertificates: (() => NodeJS.Timeout) | undefined } {
  if (listen.kind === 'unix') return { server: net.createServer(onConnection), watchCertificates: undefined };
  if (!(listen.reloadMs > 0)) throw badInput(`listen.reloadMs must be a positive number of milliseconds, got ${listen.reloadMs}.`);
  const material = readTlsMaterial(listen.tls);
  const server = tls.createServer(mutualTlsServerOptions(material), onConnection);
  server.on('tlsClientError', (error) => log({ tlsClientError: error.message.trim() }));
  return { server, watchCertificates: () => reloadTlsOnChange(server, listen.tls, tlsFingerprint(material), listen.reloadMs, log) };
}

function failureEvent(req: RpcRequest, response: RpcResponse, socket: net.Socket): Record<string, unknown> {
  return {
    requestFailed: req.method,
    code: response.error?.code,
    message: response.error?.message,
    requestId: req.requestId,
    durationMs: response.meta.timings?.durationMs,
    peer: socket.remoteAddress,
  };
}

function listenOn(server: net.Server, listen: DaemonListen): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    const listening = () => {
      server.off('error', reject);
      resolve();
    };
    if (listen.kind === 'unix') server.listen(listen.socketPath, listening);
    else server.listen(listen.port, listen.host, listening);
  });
}

async function closePlugins(ctx: AppContext): Promise<void> {
  for (const plugin of ctx.pluginRegistry.values()) await plugin.close?.();
}

export async function startDaemon(input: {
  ctx: AppContext;
  listen: DaemonListen;
  methods: DaemonMethod[];
  checkDatasource: DatasourceCheck | undefined;
  log: DaemonLog;
}): Promise<DaemonInstance> {
  const { ctx, listen, log } = input;
  if (listen.kind === 'unix') await claimSocket(listen.socketPath);
  const handlers = new Map(input.methods.map((method) => [method.name, method.handle]));
  const onOtherVersion = listen.kind === 'unix' ? stopForOtherVersion : refuseOtherVersion;
  const startedAt = Date.now();
  const deps: HandlerDeps = {
    ctx,
    sessions: new SessionRegistry(path.join(ctx.paths.stateRoot, 'run')),
    queryLimiter: new QueryLimiter(RUNTIME_CONSTANTS.daemon.maxConcurrentQueries, RUNTIME_CONSTANTS.daemon.maxQueuedQueries),
    admitDatasource: datasourceGate(ctx, input.checkDatasource),
    endpoint: () => endpointOf(server.address() as string | AddressInfo),
    startedAt,
  };
  let inFlight = 0;
  let lastActivityAt = startedAt;

  let released = false;
  const releaseSocket = (): void => {
    if (released || listen.kind !== 'unix') return;
    released = true;
    fs.rmSync(listen.socketPath, { force: true });
  };

  const onConnection = (socket: net.Socket): void => {
    let chain = Promise.resolve();
    const clientGone = new AbortController();
    socket.on('error', () => socket.destroy());
    socket.on('close', () => clientGone.abort(new Error('client disconnected before the response')));
    const onOversizedLine = (): void => log({ requestDropped: `request line over ${MAX_REQUEST_LINE_CHARS} characters`, peer: socket.remoteAddress });
    readRpcRequests(socket, onOversizedLine, (req) => {
      chain = chain.then(async () => {
        inFlight += 1;
        const handler = req.method === RpcMethod.DaemonStop || req.clientVersion === TAPROOT_VERSION ? handlers.get(req.method) : onOtherVersion;
        const { response, postWrite } = await answerRpc(req, handler, deps, clientGone.signal);
        if (!response.ok) log(failureEvent(req, response, socket));
        if (postWrite === 'stopSocket') releaseSocket();
        writeRpcResponse(socket, response);
        inFlight -= 1;
        lastActivityAt = Date.now();
        if (postWrite === 'stopSocket') {
          socket.end();
          void runRegisteredCleanup();
        }
      });
    });
  };

  const { server, watchCertificates } = serverFor(listen, onConnection, log);
  await listenOn(server, listen);
  if (listen.kind === 'unix') fs.chmodSync(listen.socketPath, 0o600);
  const endpoint = deps.endpoint();

  const timers = [
    setInterval(() => {
      for (const sessionId of deps.sessions.onTick().expiredSessionIds) {
        for (const plugin of ctx.pluginRegistry.values()) void plugin.closeSession?.(sessionId);
      }
      const idle = inFlight === 0 && Date.now() - lastActivityAt >= RUNTIME_CONSTANTS.daemon.idleExitMs;
      if (listen.kind === 'unix' && idle) onSignal();
    }, RUNTIME_CONSTANTS.sweeper.tickMs),
  ];
  if (watchCertificates) timers.push(watchCertificates());

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    for (const timer of timers) clearInterval(timer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closePlugins(ctx);
    releaseSocket();
  };
  const unregisterStop = registerCleanup(`daemon-stop:${JSON.stringify(endpoint)}`, stop);

  const onSignal = () => {
    void runRegisteredCleanup().finally(() => process.exit(0));
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  return {
    endpoint,
    stop: async () => {
      unregisterStop();
      await stop();
    },
  };
}
