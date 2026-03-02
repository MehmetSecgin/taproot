import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { nowIso } from '../core/time.js';
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

export async function startDaemon(opts: DaemonOptions = {}): Promise<{ socketPath: string; stop: () => Promise<void> }> {
  const runDir = defaultRunDir(opts.stateRoot);
  const socketPath = opts.socketPath || path.join(runDir, 'telequeryd.sock');
  const lockFile = path.join(runDir, 'telequeryd.pid');
  fs.mkdirSync(runDir, { recursive: true });

  if (fs.existsSync(socketPath)) fs.rmSync(socketPath, { force: true });
  if (fs.existsSync(lockFile)) fs.rmSync(lockFile, { force: true });

  const sessions = new SessionRegistry(runDir);
  const startedAt = Date.now();

  const server = net.createServer((socket) => {
    let buffer = '';
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
            // Phase 1 daemon skeleton: query execution will move here in next increment.
            base.ok = false;
            base.error = {
              code: 'NOT_IMPLEMENTED',
              message: 'query.execute is not implemented in daemon yet; use direct CLI query path for now.',
            };
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
          base.ok = false;
          base.error = { code: 'INTERNAL', message: (error as Error).message };
        }

        base.meta = { ...base.meta, timings: { durationMs: Date.now() - begin } };
        write(base);
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
