import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import type { RpcRequest, RpcResponse } from './types.js';

export function defaultSocketPath(stateRoot?: string): string {
  const root = stateRoot || path.join(os.homedir(), '.taproot');
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

  return await new Promise<RpcResponse>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy(new Error(`CONNECTIVITY: daemon request timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    const done = (fn: () => void): void => {
      clearTimeout(timer);
      fn();
    };

    let buffer = '';
    socket.setEncoding('utf8');

    socket.on('error', (error) => done(() => reject(error)));
    socket.on('connect', () => {
      socket.write(`${JSON.stringify(req)}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf('\n');
      if (idx < 0) return;
      const line = buffer.slice(0, idx).trim();
      if (!line) return;
      const res = JSON.parse(line) as RpcResponse;
      socket.end();
      done(() => resolve(res));
    });
  });
}
