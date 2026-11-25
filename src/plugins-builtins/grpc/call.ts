import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import type { GrpcMethodShape } from '../../core/grpc-introspect.js';
import { firstNonEmpty, textUnlessFalsy } from '../../core/text-presence.js';

type CallError = Error & {
  code?: number;
  details?: string;
};

type CallEvents = {
  data: (value: Record<string, unknown> | undefined) => void;
  error: (error: CallError) => void;
  end: () => void;
  close: () => void;
  status: () => void;
  drain: () => void;
};

type GrpcCall = {
  on: <Event extends keyof CallEvents>(event: Event, listener: CallEvents[Event]) => unknown;
  off: <Event extends keyof CallEvents>(event: Event, listener: CallEvents[Event]) => unknown;
  write: (message: unknown) => boolean;
  end: () => void;
  cancel: () => void;
};

type GrpcMethod = (...args: unknown[]) => GrpcCall;

type UnaryCallback = (error: CallError | null | undefined, response: Record<string, unknown> | undefined) => void;

type CallStart<Result> = {
  grpcMethod: GrpcMethod;
  deadline: { deadline: number };
  resolve: (value: Result) => void;
  reject: (error: Error) => void;
};

type StreamState = {
  responses: Record<string, unknown>[];
  sent: number;
  settled: boolean;
  truncated: boolean;
  failure: CallError | undefined;
};

type StreamCallResult = {
  responses: Record<string, unknown>[];
  truncated: boolean;
};

export type GrpcCallOptions = {
  client: Record<string, unknown>;
  method: GrpcMethodShape;
  metadata: unknown;
  deadlineMs: number;
  signal: AbortSignal | undefined;
};

const CALL_EVENTS_THAT_UNBLOCK_WRITES = ['drain', 'status', 'error', 'close'] as const;

function requestsStream(method: GrpcMethodShape): boolean {
  return method.requestStream === true;
}

function responsesStream(method: GrpcMethodShape): boolean {
  return method.responseStream === true;
}

export function isStreamingMethod(method: GrpcMethodShape): boolean {
  return requestsStream(method) || responsesStream(method);
}

function isGrpcCall(value: unknown): value is GrpcCall {
  return typeof value === 'object' && value !== null && 'cancel' in value && typeof value.cancel === 'function';
}

function bindGrpcMethod(client: Record<string, unknown>, methodName: string): GrpcMethod {
  const method = client[methodName];
  if (typeof method !== 'function') {
    throw new TypeError(`grpc method '${methodName}' not found on service. Check spelling and that the .proto defines it.`);
  }
  return (...args) => {
    const call: unknown = Reflect.apply(method, client, args);
    if (!isGrpcCall(call)) {
      throw new TypeError(`grpc method '${methodName}' did not return a call`);
    }
    return call;
  };
}

async function openCall<Result>(options: GrpcCallOptions, start: (context: CallStart<Result>) => GrpcCall): Promise<Result> {
  const { client, method, deadlineMs, signal } = options;
  const grpcMethod = bindGrpcMethod(client, method.name);
  const deadline = { deadline: Date.now() + Math.max(1, deadlineMs) };
  const active: { call: GrpcCall | undefined } = { call: undefined };
  const cancel = (): void => {
    active.call?.cancel();
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    return await new Promise<Result>((resolve, reject) => {
      active.call = start({ grpcMethod, deadline, resolve, reject });
      if (signal?.aborted === true) {
        active.call.cancel();
      }
    });
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

function describeCallError(error: CallError): string {
  const code = typeof error.code === 'number' ? `grpc_code=${error.code} ` : '';
  return `${code}${firstNonEmpty(textUnlessFalsy(error.details), textUnlessFalsy(error.message)) ?? 'grpc call failed'}`;
}

export async function callUnary(options: GrpcCallOptions, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  return openCall(options, ({ grpcMethod, deadline, resolve, reject }) => {
    const onResponse: UnaryCallback = (error, response) => {
      if (error === null || error === undefined) {
        resolve(response ?? {});
      } else {
        reject(new Error(describeCallError(error)));
      }
    };
    return grpcMethod(payload, options.metadata, deadline, onResponse);
  });
}

async function waitForDrain(call: GrpcCall): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      for (const event of CALL_EVENTS_THAT_UNBLOCK_WRITES) {
        call.off(event, done);
      }
      resolve();
    };
    for (const event of CALL_EVENTS_THAT_UNBLOCK_WRITES) {
      call.on(event, done);
    }
  });
}

function streamFailureError(error: CallError, state: StreamState): Error {
  const { sent, responses } = state;
  const failure = new Error(`${describeCallError(error)} (stream failed after ${responses.length} responses, ${sent} requests sent)`);
  return Object.assign(failure, {
    details: {
      stream: { sent, received: responses.length, grpcCode: error.code },
      receivedRows: responses
        .slice(0, RUNTIME_CONSTANTS.grpc.streamFailureRowLimit)
        .map((value, seq) => ({ seq, value })),
    },
  });
}

function settleStream(state: StreamState, resolve: (result: StreamCallResult) => void, reject: (error: Error) => void): void {
  if (state.settled) {
    return;
  }
  state.settled = true;
  if (state.failure !== undefined && !state.truncated) {
    reject(streamFailureError(state.failure, state));
  } else {
    resolve({ responses: state.responses, truncated: state.truncated });
  }
}

type StreamingCallInput = {
  start: CallStart<StreamCallResult>;
  options: GrpcCallOptions;
  messages: Record<string, unknown>[];
  onResponse: UnaryCallback;
};

type StreamContext = {
  state: StreamState;
  settle: () => void;
};

function startStreamingCall({ start, options, messages, onResponse }: StreamingCallInput): GrpcCall {
  const { grpcMethod, deadline } = start;
  const { method, metadata } = options;
  if (!requestsStream(method)) {
    return grpcMethod(messages[0], metadata, deadline);
  }
  return responsesStream(method) ? grpcMethod(metadata, deadline) : grpcMethod(metadata, deadline, onResponse);
}

function listenForStreamedResponses(call: GrpcCall, { state, settle }: StreamContext): void {
  const responseLimit = RUNTIME_CONSTANTS.grpc.streamMessageLimit;
  call.on('data', (value) => {
    if (state.settled) {
      return;
    }
    state.responses.push(value ?? {});
    if (state.responses.length < responseLimit) {
      return;
    }
    state.truncated = true;
    settle();
    call.cancel();
  });
  call.on('error', (error) => {
    state.failure ??= error;
  });
  call.on('end', settle);
  call.on('close', settle);
}

function toCallError(error: unknown): CallError {
  return error instanceof Error ? error : new Error(String(error));
}

async function writeAllMessages(call: GrpcCall, messages: Record<string, unknown>[], state: StreamState): Promise<void> {
  for (const message of messages) {
    if (state.settled || state.failure !== undefined) {
      return;
    }
    state.sent += 1;
    if (!call.write(message)) {
      await waitForDrain(call);
    }
  }
  if (!state.settled && state.failure === undefined) {
    call.end();
  }
}

async function writeMessages(call: GrpcCall, messages: Record<string, unknown>[], { state, settle }: StreamContext): Promise<void> {
  try {
    await writeAllMessages(call, messages, state);
  } catch (error) {
    state.failure ??= toCallError(error);
    settle();
  }
}

export async function callStreaming(options: GrpcCallOptions, messages: Record<string, unknown>[]): Promise<StreamCallResult> {
  const { method } = options;
  return openCall(options, (start) => {
    const state: StreamState = { responses: [], sent: requestsStream(method) ? 0 : 1, settled: false, truncated: false, failure: undefined };
    const settle = (): void => {
      settleStream(state, start.resolve, start.reject);
    };
    const onResponse: UnaryCallback = (error, response) => {
      if (error !== null && error !== undefined) {
        state.failure = error;
      } else if (!state.settled) {
        state.responses.push(response ?? {});
      }
      settle();
    };
    const call = startStreamingCall({ start, options, messages, onResponse });
    if (responsesStream(method)) {
      listenForStreamedResponses(call, { state, settle });
    }
    if (requestsStream(method)) {
      void writeMessages(call, messages, { state, settle });
    }
    return call;
  });
}
