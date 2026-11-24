import net from 'node:net';
import tls from 'node:tls';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { connectivity } from '../core/taproot-error.js';
import { mutualTlsClientOptions } from './transport.js';
import type { HostPort, MutualTlsFiles } from './transport.js';
import { encodeRequest, parseReply } from './rpc-framing.js';
import { waitMs } from '../core/wait.js';
import type { RpcResponse } from './types.js';
import { defaultSocketPath } from './socket-path.js';
import { isNonEmpty } from '../core/text-presence.js';

type RpcCallInput = {
  method: string;
  params?: Record<string, unknown>;
  timeoutMs?: number;
};

type SocketOpener = () => { socket: net.Socket; readyEvent: string };

type ReplySettler = {
  succeed: (reply: RpcResponse) => void;
  fail: (error: Error) => void;
};

const RETRYABLE_CODES = new Set(['ECONNREFUSED', 'EAGAIN']);
const RETRY_DELAY_MS = 100;

function createReplySettler(promise: { resolve: (reply: RpcResponse) => void; reject: (error: Error) => void }, timer: NodeJS.Timeout): ReplySettler {
  let settled = false;
  const settleOnce = (settle: () => void): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timer);
    settle();
  };
  return {
    succeed: (reply) => {
      settleOnce(() => {
        promise.resolve(reply);
      });
    },
    fail: (error) => {
      settleOnce(() => {
        promise.reject(error);
      });
    },
  };
}

function toError(thrown: unknown): Error {
  return thrown instanceof Error ? thrown : new Error(String(thrown));
}

function listenForReply(socket: net.Socket, settler: ReplySettler): void {
  let replyReceived = false;
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('error', settler.fail);
  socket.on('close', () => {
    if (!replyReceived) {
      settler.fail(connectivity('daemon socket closed before response'));
    }
  });
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    const newlineIndex = buffer.indexOf('\n');
    const line = newlineIndex === -1 ? '' : buffer.slice(0, newlineIndex).trim();
    if (line === '') {
      return;
    }
    replyReceived = true;
    socket.end();
    try {
      settler.succeed(parseReply(line));
    } catch (error) {
      settler.fail(toError(error));
    }
  });
}

async function sendRequestAndAwaitReply(openSocket: SocketOpener, input: RpcCallInput): Promise<RpcResponse> {
  const timeoutMs = input.timeoutMs ?? RUNTIME_CONSTANTS.rpc.requestTimeoutMs;
  const requestLine = encodeRequest(input);
  return new Promise<RpcResponse>((resolve, reject) => {
    const { socket, readyEvent } = openSocket();
    const timer = setTimeout(() => {
      socket.destroy(connectivity(`daemon request timeout (${timeoutMs}ms)`));
    }, timeoutMs);
    listenForReply(socket, createReplySettler({ resolve, reject }, timer));
    socket.on(readyEvent, () => {
      socket.write(requestLine);
    });
  });
}

function isRetryableConnectError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && typeof error.code === 'string' && RETRYABLE_CODES.has(error.code);
}

export async function rpcCall(input: RpcCallInput & { socketPath?: string }): Promise<RpcResponse> {
  const socketPath = isNonEmpty(input.socketPath) ? input.socketPath : defaultSocketPath();
  const attempt = async (): Promise<RpcResponse> => sendRequestAndAwaitReply(() => ({ socket: net.createConnection(socketPath), readyEvent: 'connect' }), input);
  try {
    return await attempt();
  } catch (error) {
    if (!isRetryableConnectError(error)) {
      throw error;
    }
    await waitMs(RETRY_DELAY_MS);
    return attempt();
  }
}

export async function remoteRpcCall(input: RpcCallInput & { server: HostPort; tls: MutualTlsFiles }): Promise<RpcResponse> {
  return sendRequestAndAwaitReply(() => ({ socket: tls.connect(mutualTlsClientOptions(input.tls, input.server)), readyEvent: 'secureConnect' }), input);
}
