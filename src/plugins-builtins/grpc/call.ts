import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import type { RpcMethodShape } from '../../types/core.js';

type Listener = (...args: any[]) => void;

interface GrpcCall {
  on: (event: string, listener: Listener) => unknown;
  off: (event: string, listener: Listener) => unknown;
  write: (message: unknown) => boolean;
  end: () => void;
  cancel: () => void;
}

type GrpcMethod = (...args: unknown[]) => GrpcCall;

interface CallError extends Error {
  code?: number;
  details?: string;
}

export interface StreamCallResult {
  responses: Record<string, unknown>[];
  truncated: boolean;
}

export function isStreamingMethod(method: RpcMethodShape): boolean {
  return Boolean(method.requestStream || method.responseStream);
}

function openCall<T>(
  client: Record<string, unknown>,
  methodName: string,
  deadlineMs: number,
  signal: AbortSignal | undefined,
  start: (grpcMethod: GrpcMethod, options: { deadline: number }, resolve: (value: T) => void, reject: (error: Error) => void) => GrpcCall,
): Promise<T> {
  const method = client[methodName];
  if (typeof method !== 'function') {
    return Promise.reject(new Error(`grpc method '${methodName}' not found on service. Check spelling and that the .proto defines it.`));
  }
  const options = { deadline: Date.now() + Math.max(1, deadlineMs) };
  let call: GrpcCall | undefined;
  const cancel = (): void => call?.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  return new Promise<T>((resolve, reject) => {
    call = start(method.bind(client) as GrpcMethod, options, resolve, reject);
    if (signal?.aborted) call.cancel();
  }).finally(() => signal?.removeEventListener('abort', cancel));
}

function describeCallError(err: CallError): string {
  const code = typeof err.code === 'number' ? `grpc_code=${err.code} ` : '';
  return `${code}${err.details || err.message || 'grpc call failed'}`;
}

export function callUnary(
  client: Record<string, unknown>,
  method: RpcMethodShape,
  payload: Record<string, unknown>,
  metadata: unknown,
  deadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<Record<string, unknown>> {
  return openCall(client, method.name, deadlineMs, signal, (grpcMethod, options, resolve, reject) =>
    grpcMethod(payload, metadata, options, (err: CallError | null, response: Record<string, unknown>) => {
      if (err) reject(new Error(describeCallError(err)));
      else resolve(response || {});
    }),
  );
}

function waitForDrain(call: GrpcCall): Promise<void> {
  return new Promise((resolve) => {
    const events = ['drain', 'status', 'error', 'close'];
    const done = (): void => {
      for (const event of events) call.off(event, done);
      resolve();
    };
    for (const event of events) call.on(event, done);
  });
}

function streamFailure(err: CallError, sent: number, responses: Record<string, unknown>[]): Error {
  const error = new Error(
    `${describeCallError(err)} (stream failed after ${responses.length} responses, ${sent} requests sent)`,
  ) as Error & { details?: Record<string, unknown> };
  error.details = {
    stream: { sent, received: responses.length, grpcCode: err.code },
    receivedRows: responses
      .slice(0, RUNTIME_CONSTANTS.grpc.streamFailureRowLimit)
      .map((value, seq) => ({ seq, value })),
  };
  return error;
}

export function callStreaming(
  client: Record<string, unknown>,
  method: RpcMethodShape,
  messages: Record<string, unknown>[],
  metadata: unknown,
  deadlineMs: number,
  signal: AbortSignal | undefined,
): Promise<StreamCallResult> {
  const responseLimit = RUNTIME_CONSTANTS.grpc.streamMessageLimit;
  return openCall(client, method.name, deadlineMs, signal, (grpcMethod, options, resolve, reject) => {
    const responses: Record<string, unknown>[] = [];
    let sent = 0;
    let settled = false;
    let truncated = false;
    let failure: CallError | undefined;

    const settle = (): void => {
      if (settled) return;
      settled = true;
      if (failure && !truncated) reject(streamFailure(failure, sent, responses));
      else resolve({ responses, truncated });
    };

    const onSingleResponse = (err: CallError | null, response: Record<string, unknown>): void => {
      if (err) failure = err;
      else if (!settled) responses.push(response || {});
      settle();
    };

    let call: GrpcCall;
    if (!method.requestStream) {
      sent = 1;
      call = grpcMethod(messages[0], metadata, options);
    } else if (!method.responseStream) {
      call = grpcMethod(metadata, options, onSingleResponse);
    } else {
      call = grpcMethod(metadata, options);
    }

    if (method.responseStream) {
      call.on('data', (value: Record<string, unknown> | undefined) => {
        if (settled) return;
        responses.push(value || {});
        if (responses.length < responseLimit) return;
        truncated = true;
        settle();
        call.cancel();
      });
      call.on('error', (err: CallError) => {
        failure = failure || err;
      });
      call.on('end', settle);
      call.on('close', settle);
    }

    if (method.requestStream) {
      const writeAll = async (): Promise<void> => {
        for (const message of messages) {
          if (settled || failure) return;
          sent += 1;
          if (!call.write(message)) await waitForDrain(call);
        }
        if (!settled && !failure) call.end();
      };
      writeAll().catch((err: CallError) => {
        failure = failure || err;
        settle();
      });
    }

    return call;
  });
}
