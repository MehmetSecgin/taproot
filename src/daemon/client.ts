import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { connectivity } from '../core/error-classification.js';
import { TAPROOT_VERSION } from '../core/version.js';
import { mutualTlsClientOptions, type HostPort, type MutualTlsFiles } from './transport.js';
import type { RpcRequest, RpcResponse } from './types.js';

interface RpcCallInput {
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
}

const RETRYABLE_CODES = new Set(['ECONNREFUSED', 'EAGAIN']);

export function defaultSocketPath(stateRoot?: string): string {
  const root = stateRoot || process.env.TAPROOT_STATE_ROOT || path.join(os.homedir(), '.taproot');
  return path.join(root, 'run', 'taprootd.sock');
}

function exchange(connect: () => { socket: net.Socket; readyEvent: string }, input: RpcCallInput): Promise<RpcResponse> {
  const timeoutMs = input.timeoutMs ?? RUNTIME_CONSTANTS.rpc.requestTimeoutMs;
  const req: RpcRequest = {
    protocolVersion: RUNTIME_CONSTANTS.protocolVersion,
    clientVersion: TAPROOT_VERSION,
    requestId: randomUUID(),
    method: input.method,
    params: input.params || {},
  };
  const payload = `${JSON.stringify(req)}\n`;

  return new Promise<RpcResponse>((resolve, reject) => {
    const { socket, readyEvent } = connect();
    let settled = false;
    let received = false;
    const timer = setTimeout(() => {
      if (settled) return;
      socket.destroy(connectivity(`daemon request timeout (${timeoutMs}ms)`));
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
      settle(() => reject(connectivity('daemon socket closed before response')));
    });
    socket.on(readyEvent, () => {
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
}

export async function rpcCall(input: RpcCallInput & { socketPath?: string }): Promise<RpcResponse> {
  const socketPath = input.socketPath || defaultSocketPath();
  const attempt = () => exchange(() => ({ socket: net.createConnection(socketPath), readyEvent: 'connect' }), input);
  try {
    return await attempt();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (!code || !RETRYABLE_CODES.has(code)) throw error;
    await new Promise((r) => setTimeout(r, 100));
    return await attempt();
  }
}

export function remoteRpcCall(input: RpcCallInput & { server: HostPort; tls: MutualTlsFiles }): Promise<RpcResponse> {
  return exchange(() => ({ socket: tls.connect(mutualTlsClientOptions(input.tls, input.server)), readyEvent: 'secureConnect' }), input);
}
