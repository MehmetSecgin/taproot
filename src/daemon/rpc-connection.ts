import type net from 'node:net';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { classifyError } from '../core/error-classification.js';
import type { Handler, HandlerDeps, HandlerResult } from './handlers/types.js';
import type { RpcRequest, RpcResponse } from './types.js';

const MAX_REQUEST_LINE_CHARS = 1024 * 1024;

function parseRequestLine(line: string): RpcRequest {
  const parsed = JSON.parse(line) as RpcRequest;
  if (parsed.protocolVersion !== RUNTIME_CONSTANTS.protocolVersion) {
    throw new Error(`Unsupported protocolVersion=${parsed.protocolVersion}`);
  }
  if (!parsed.requestId || !parsed.method || typeof parsed.params !== 'object' || parsed.params === null) {
    throw new Error('Invalid RPC request envelope');
  }
  return parsed;
}

export function writeRpcResponse(socket: net.Socket, response: RpcResponse): void {
  socket.write(`${JSON.stringify(response)}\n`);
}

function requestOrBadRequest(socket: net.Socket, line: string): RpcRequest | undefined {
  try {
    return parseRequestLine(line);
  } catch (error) {
    writeRpcResponse(socket, {
      protocolVersion: RUNTIME_CONSTANTS.protocolVersion,
      requestId: 'unknown',
      ok: false,
      error: { code: 'BAD_REQUEST', message: (error as Error).message },
      meta: {},
    });
    return undefined;
  }
}

export function readRpcRequests(socket: net.Socket, onRequest: (req: RpcRequest) => void): void {
  let buffer = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffer += chunk;
    let idx = buffer.indexOf('\n');
    while (idx >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      const req = line ? requestOrBadRequest(socket, line) : undefined;
      if (req) onRequest(req);
      idx = buffer.indexOf('\n');
    }
    if (buffer.length > MAX_REQUEST_LINE_CHARS) socket.destroy();
  });
}

export async function answerRpc(
  req: RpcRequest,
  handler: Handler | undefined,
  deps: HandlerDeps,
  clientGone: AbortSignal,
): Promise<{ response: RpcResponse; postWrite: HandlerResult['postWrite'] }> {
  const begin = Date.now();
  const response: RpcResponse = { protocolVersion: RUNTIME_CONSTANTS.protocolVersion, requestId: req.requestId, ok: false, meta: {} };
  let postWrite: HandlerResult['postWrite'];
  try {
    if (handler) {
      postWrite = (await handler({ req, base: response, deps, clientGone }))?.postWrite;
    } else {
      response.error = { code: 'UNKNOWN_METHOD', message: `Unknown RPC method: ${req.method}` };
    }
  } catch (error) {
    const message = (error as Error).message;
    response.ok = false;
    response.error = { code: classifyError(message), message, details: (error as Error & { details?: Record<string, unknown> }).details };
  }
  response.meta = { ...response.meta, timings: { durationMs: Date.now() - begin } };
  return { response, postWrite };
}
