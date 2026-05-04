import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import type { RpcRequest, RpcResponse } from './types.js';

export function defaultSocketPath(stateRoot?: string): string {
  const root = stateRoot || process.env.TAPROOT_STATE_ROOT || path.join(os.homedir(), '.taproot');
  return path.join(root, 'run', 'taprootd.sock');
}

export async function rpcCall(input: {
  method: string;
  params?: Record<string, unknown>;
  socketPath?: string;
  timeoutMs?: number;
}): Promise<RpcResponse> {
  const socketPath = input.socketPath || defaultSocketPath();
  const timeoutMs = input.timeoutMs ?? RUNTIME_CONSTANTS.rpc.requestTimeoutMs;
  const req: RpcRequest = {
    protocolVersion: RUNTIME_CONSTANTS.protocolVersion,
    requestId: randomUUID(),
    method: input.method,
    params: input.params || {},
  };
  const payload = `${JSON.stringify(req)}\n`;

  const RETRYABLE_CODES = new Set(['ECONNREFUSED', 'ENOENT', 'EAGAIN']);

  const attempt = (): Promise<RpcResponse> =>
    new Promise<RpcResponse>((resolve, reject) => {
      const socket = net.createConnection(socketPath);
      let settled = false;
      let received = false;
      const timer = setTimeout(() => {
        if (settled) return;
        socket.destroy(new Error(`CONNECTIVITY: daemon request timeout (${timeoutMs}ms)`));
      }, timeoutMs);

      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      let buffer = '';
      socket.setEncoding('utf8');

      socket.on('error', (error) => settle(() => reject(error)));
      socket.on('close', () => {
        if (received) return;
        settle(() => reject(new Error('CONNECTIVITY: daemon socket closed before response')));
      });
      socket.on('connect', () => {
        socket.write(payload);
      });
      socket.on('data', (chunk) => {
        buffer += chunk;
        const idx = buffer.indexOf('\n');
        if (idx < 0) return;
        const line = buffer.slice(0, idx).trim();
        if (!line) return;
        received = true;
        let res: RpcResponse;
        try {
          res = JSON.parse(line) as RpcResponse;
        } catch (error) {
          settle(() => reject(error as Error));
          socket.end();
          return;
        }
        socket.end();
        settle(() => resolve(res));
      });
    });

  try {
    return await attempt();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (!code || !RETRYABLE_CODES.has(code)) throw error;
    await new Promise((r) => setTimeout(r, 100));
    return await attempt();
  }
}
