import type net from 'node:net';
import { runRegisteredCleanup } from '../core/process-cleanup.js';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { classifyError } from '../core/error-classification.js';
import { TAPROOT_VERSION } from '../core/version.js';
import type { Handler, HandlerDeps, HandlerResult } from './methods/types.js';
import { RpcMethod } from './types.js';
import type { RpcRequest, RpcResponse } from './types.js';
import { parseRequestLine } from './request-line.js';
import { propertyOf } from '../core/object-property.js';
import { errorText } from '../core/error-text.js';

const BYTES_PER_KIBIBYTE = 1024;
const MAX_REQUEST_LINE_CHARS = BYTES_PER_KIBIBYTE * BYTES_PER_KIBIBYTE;

export type ConnectionActivity = {
  activeRequests: number;
  lastActivityAt: number;
};

export type ConnectionServing = {
  handlers: Map<string, Handler>;
  onOtherVersion: Handler;
  deps: HandlerDeps;
  activity: ConnectionActivity;
  log: (event: Record<string, unknown>) => void;
  startClosingServer: () => void;
};

type AnswerInput = {
  request: RpcRequest;
  handler: Handler | undefined;
  deps: HandlerDeps;
  clientGone: AbortSignal;
};

type Answer = {
  response: RpcResponse;
  postWrite: HandlerResult['postWrite'];
};

function writeRpcResponse(socket: net.Socket, response: RpcResponse): void {
  socket.write(`${JSON.stringify(response)}\n`);
}

function parseOrReplyBadRequest(socket: net.Socket, line: string): RpcRequest | undefined {
  try {
    return parseRequestLine(line);
  } catch (error) {
    writeRpcResponse(socket, {
      protocolVersion: RUNTIME_CONSTANTS.protocolVersion,
      requestId: 'unknown',
      ok: false,
      error: { code: 'BAD_REQUEST', message: errorText(error) },
      meta: {},
    });
    return undefined;
  }
}

function describeThrown(error: unknown): { message: string; details: unknown } {
  return { message: errorText(error), details: propertyOf(error, 'details') };
}

function splitCompleteLines(buffer: string): { lines: string[]; remainder: string } {
  const lines = buffer.split('\n');
  const remainder = lines.pop() ?? '';
  return { lines: lines.map((line) => line.trim()), remainder };
}

function readRpcRequests(socket: net.Socket, onOversizedLine: () => void, onRequest: (request: RpcRequest) => void): void {
  let unterminatedLine = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    const { lines, remainder } = splitCompleteLines(unterminatedLine + chunk);
    unterminatedLine = remainder;
    for (const line of lines.filter((candidate) => candidate !== '')) {
      const request = parseOrReplyBadRequest(socket, line);
      if (request !== undefined) {
        onRequest(request);
      }
    }
    if (unterminatedLine.length > MAX_REQUEST_LINE_CHARS) {
      onOversizedLine();
      socket.destroy();
    }
  });
}

function recordThrown(response: RpcResponse, error: unknown): void {
  const { message, details } = describeThrown(error);
  response.ok = false;
  response.error = { code: classifyError(message), message, details };
}

async function runHandler(input: AnswerInput, response: RpcResponse): Promise<HandlerResult['postWrite']> {
  if (input.handler === undefined) {
    response.error = { code: 'UNKNOWN_METHOD', message: `Unknown RPC method: ${input.request.method}` };
    return undefined;
  }
  try {
    const result = await input.handler({ req: input.request, base: response, deps: input.deps, clientGone: input.clientGone });
    return result?.postWrite;
  } catch (error) {
    recordThrown(response, error);
    return undefined;
  }
}

async function answerRpc(input: AnswerInput): Promise<Answer> {
  const startedAt = Date.now();
  const response: RpcResponse = { protocolVersion: RUNTIME_CONSTANTS.protocolVersion, requestId: input.request.requestId, ok: false, meta: {} };
  const postWrite = await runHandler(input, response);
  response.meta = { ...response.meta, timings: { durationMs: Date.now() - startedAt } };
  return { response, postWrite };
}

function handlerFor(request: RpcRequest, serving: ConnectionServing): Handler | undefined {
  const clientMatchesDaemon = request.method === RpcMethod.DaemonStop || request.clientVersion === TAPROOT_VERSION;
  return clientMatchesDaemon ? serving.handlers.get(request.method) : serving.onOtherVersion;
}

function requestFailedEvent(request: RpcRequest, response: RpcResponse, socket: net.Socket): Record<string, unknown> {
  return {
    requestFailed: request.method,
    code: response.error?.code,
    message: response.error?.message,
    requestId: request.requestId,
    durationMs: response.meta.timings?.durationMs,
    peer: socket.remoteAddress,
  };
}

type ConnectionHandle = {
  socket: net.Socket;
  clientGone: AbortSignal;
};

function recordFinishedRequest(activity: ConnectionActivity): void {
  activity.activeRequests -= 1;
  activity.lastActivityAt = Date.now();
}

function endConnectionAndCleanUp(socket: net.Socket): void {
  socket.end();
  void runRegisteredCleanup();
}

async function answerAndReply(connection: ConnectionHandle, request: RpcRequest, serving: ConnectionServing): Promise<void> {
  const { response, postWrite } = await answerRpc({ request, handler: handlerFor(request, serving), deps: serving.deps, clientGone: connection.clientGone });
  const stopsDaemon = postWrite === 'stopSocket';
  if (!response.ok) {
    serving.log(requestFailedEvent(request, response, connection.socket));
  }
  if (stopsDaemon) {
    serving.startClosingServer();
  }
  writeRpcResponse(connection.socket, response);
  if (stopsDaemon) {
    endConnectionAndCleanUp(connection.socket);
  }
}

async function serveRequest(connection: ConnectionHandle, request: RpcRequest, serving: ConnectionServing): Promise<void> {
  serving.activity.activeRequests += 1;
  await answerAndReply(connection, request, serving);
  recordFinishedRequest(serving.activity);
}

export function serveConnection(socket: net.Socket, serving: ConnectionServing): void {
  let pendingRequests = Promise.resolve();
  const clientGone = new AbortController();
  const connection: ConnectionHandle = { socket, clientGone: clientGone.signal };
  socket.on('error', () => {
    socket.destroy();
  });
  socket.on('close', () => {
    clientGone.abort(new Error('client disconnected before the response'));
  });
  const onOversizedLine = (): void => {
    serving.log({ requestDropped: `request line over ${MAX_REQUEST_LINE_CHARS} characters`, peer: socket.remoteAddress });
  };
  readRpcRequests(socket, onOversizedLine, (request) => {
    const previousRequests = pendingRequests;
    pendingRequests = (async (): Promise<void> => {
      await previousRequests;
      await serveRequest(connection, request, serving);
    })();
  });
}
