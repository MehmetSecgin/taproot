import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { buildContext, classifyError } from '../core/app.js';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { registerCleanup, runRegisteredCleanup } from '../core/cleanup.js';
import type { RpcRequest, RpcResponse } from './types.js';
import type { PluginRegistry } from '../plugins/load-builtins.js';
import { QueryLimiter } from './query-limiter.js';
import { SessionRegistry } from './session-registry.js';
import { closeAllTeleportMysqlProxies, closeTeleportMysqlSessionProxies } from '../plugins-builtins/teleport-mysql/index.js';
import { closeAllMysqlPools } from '../plugins-builtins/_shared/db-conn.js';
import { rpcCall } from './client.js';
import { handleVersionMismatch } from './handlers/daemon-status.js';
import { HANDLERS, type HandlerDeps } from './handlers/index.js';
import { RpcMethod } from './types.js';
import { TAPROOT_VERSION } from '../core/version.js';

export interface DaemonOptions {
  stateRoot?: string;
  socketPath?: string;
  configurePlugins?: (registry: PluginRegistry) => void;
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

export async function startDaemon(opts: DaemonOptions = {}): Promise<{ socketPath: string; stop: () => Promise<void> }> {
  const runDir = defaultRunDir(opts.stateRoot);
  const socketPath = opts.socketPath || path.join(runDir, 'taprootd.sock');
  const lockFile = path.join(runDir, 'taprootd.pid');
  fs.mkdirSync(runDir, { recursive: true });

  if (fs.existsSync(socketPath)) {
    const alive = await rpcCall({ socketPath, method: RpcMethod.DaemonStatus }).then((res) => res.ok, () => false);
    if (alive) throw new Error(`taprootd already running on ${socketPath}`);
    fs.rmSync(socketPath, { force: true });
  }
  if (fs.existsSync(lockFile)) fs.rmSync(lockFile, { force: true });

  const sessions = new SessionRegistry(runDir);
  const queryLimiter = new QueryLimiter(RUNTIME_CONSTANTS.daemon.maxConcurrentQueries, RUNTIME_CONSTANTS.daemon.maxQueuedQueries);
  const ctx = buildContext({});
  opts.configurePlugins?.(ctx.pluginRegistry);
  const startedAt = Date.now();

  const deps: HandlerDeps = { ctx, sessions, queryLimiter, socketPath, startedAt };
  let inFlight = 0;
  let lastActivityAt = startedAt;

  const server = net.createServer((socket) => {
    let buffer = '';
    let chain = Promise.resolve();
    const clientGone = new AbortController();
    socket.setEncoding('utf8');
    socket.on('close', () => clientGone.abort(new Error('client disconnected before the response')));

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
          inFlight += 1;
          const begin = Date.now();
          const base = responseBase(req);
          let postWrite: 'stopSocket' | undefined;
          try {
            const handler =
              req.method === RpcMethod.DaemonStop || req.clientVersion === TAPROOT_VERSION ? HANDLERS.get(req.method) : handleVersionMismatch;
            if (!handler) {
              base.ok = false;
              base.error = { code: 'UNKNOWN_METHOD', message: `Unknown RPC method: ${req.method}` };
            } else {
              const result = await handler({ req, base, deps, clientGone: clientGone.signal });
              postWrite = result?.postWrite;
            }
          } catch (error) {
            const message = (error as Error).message;
            const code = classifyError(message);
            base.ok = false;
            base.error = {
              code,
              message,
              details: (error as Error & { details?: Record<string, unknown> }).details,
            };
          }

          base.meta = { ...base.meta, timings: { durationMs: Date.now() - begin } };
          if (postWrite === 'stopSocket') releaseSocket();
          write(base);
          inFlight -= 1;
          lastActivityAt = Date.now();

          if (postWrite === 'stopSocket') {
            socket.end();
            void runRegisteredCleanup();
          }
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
    if (inFlight === 0 && Date.now() - lastActivityAt >= RUNTIME_CONSTANTS.daemon.idleExitMs) onSignal();
  }, RUNTIME_CONSTANTS.sweeper.tickMs);

  let released = false;
  const releaseSocket = (): void => {
    if (released) return;
    released = true;
    fs.rmSync(socketPath, { force: true });
    fs.rmSync(lockFile, { force: true });
  };

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await closeAllTeleportMysqlProxies();
    await closeAllMysqlPools();
    releaseSocket();
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
