import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import type { RpcRequest, RpcResponse } from './types.js';

export function defaultSocketPath(stateRoot?: string): string {
  const root = stateRoot || path.join(os.homedir(), '.telequery');
  return path.join(root, 'run', 'telequeryd.sock');
}

export async function rpcCall(input: {
  method: string;
  params?: Record<string, unknown>;
  socketPath?: string;
}): Promise<RpcResponse> {
  const socketPath = input.socketPath || defaultSocketPath();
  const req: RpcRequest = {
    protocolVersion: RUNTIME_CONSTANTS.protocolVersion,
    requestId: randomUUID(),
    method: input.method,
    params: input.params || {},
  };

  return await new Promise<RpcResponse>((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');

    socket.on('error', (error) => reject(error));
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
      resolve(res);
    });
  });
}
