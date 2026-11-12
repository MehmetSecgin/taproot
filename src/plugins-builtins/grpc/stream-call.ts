import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import type { RpcMethodShape } from '../../types/core.js';

type Listener = (...args: any[]) => void;

interface StreamCall {
  on: (event: string, listener: Listener) => unknown;
  off: (event: string, listener: Listener) => unknown;
  write: (message: unknown) => boolean;
  end: () => void;
  cancel: () => void;
}

interface CallError extends Error {
  code?: number;
  details?: string;
}

export interface StreamCallResult {
  responses: Record<string, unknown>[];
  truncated: boolean;
}

export function cancelOnAbort(call: { cancel: () => void }, signal: AbortSignal | undefined): () => void {
  const cancel = (): void => call.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  return () => signal?.removeEventListener('abort', cancel);
}

export function isStreamingMethod(method: RpcMethodShape): boolean {
  return Boolean(method.requestStream || method.responseStream);
}

function waitForDrain(call: StreamCall): Promise<void> {
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
  const detail = err.details || err.message || 'grpc stream failed';
  const code = typeof err.code === 'number' ? `grpc_code=${err.code} ` : '';
  const error = new Error(
    `${code}${detail} (stream failed after ${responses.length} responses, ${sent} requests sent)`,
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
  const fn = client[method.name];
  if (typeof fn !== 'function') {
    return Promise.reject(new Error(`grpc method '${method.name}' not found on service. Check spelling and that the .proto defines it.`));
  }
  const options = { deadline: Date.now() + Math.max(1, deadlineMs) };
  const responseLimit = RUNTIME_CONSTANTS.grpc.streamMessageLimit;
  return new Promise((resolve, reject) => {
    const responses: Record<string, unknown>[] = [];
    let sent = 0;
    let settled = false;
    let truncated = false;
    let failure: CallError | undefined;

    const settle = (): void => {
      if (settled) return;
      settled = true;
      stopCancelling();
      if (failure && !truncated) reject(streamFailure(failure, sent, responses));
      else resolve({ responses, truncated });
    };

    const onResponse = (value: Record<string, unknown> | undefined): void => {
      if (settled) return;
      responses.push(value || {});
      if (method.responseStream && responses.length >= responseLimit) {
        truncated = true;
        settle();
        call.cancel();
      }
    };

    let call: StreamCall;
    if (!method.requestStream) {
      sent = 1;
      call = (fn as (req: unknown, md: unknown, opts: unknown) => StreamCall).call(client, messages[0], metadata, options);
    } else if (!method.responseStream) {
      call = (fn as (md: unknown, opts: unknown, cb: Listener) => StreamCall).call(
        client,
        metadata,
        options,
        (err: CallError | null, response: Record<string, unknown>) => {
          if (err) failure = err;
          else onResponse(response);
          settle();
        },
      );
    } else {
      call = (fn as (md: unknown, opts: unknown) => StreamCall).call(client, metadata, options);
    }
    const stopCancelling = cancelOnAbort(call, signal);

    if (method.responseStream) {
      call.on('data', onResponse);
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
  });
}
