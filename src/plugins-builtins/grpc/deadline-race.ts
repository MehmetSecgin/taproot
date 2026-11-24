import { queryTimeoutError } from '../../core/query-timeout.js';
import type { QueryRequest } from '../../types/plugin.js';
import { errorMessage } from '../_shared/error-message.js';
import { callStreaming, callUnary, isStreamingMethod } from './call.js';
import type { GrpcCallOptions } from './call.js';

type CallRows = {
  rows: unknown[][];
  warnings: string[];
};

const BACKUP_TIMEOUT_SLACK_MS = 500;

async function streamRows(options: GrpcCallOptions, messages: Record<string, unknown>[]): Promise<CallRows> {
  const result = await callStreaming(options, messages);
  const warnings = result.truncated
    ? [`response stream stopped at ${result.responses.length} messages. Narrow the request or raise TAPROOT_GRPC_STREAM_MESSAGE_LIMIT.`]
    : [];
  return { rows: result.responses.map((value, seq) => [seq, value]), warnings };
}

async function unaryRows(options: GrpcCallOptions, messages: Record<string, unknown>[]): Promise<CallRows> {
  const response = await callUnary(options, messages[0]);
  return { rows: [[response]], warnings: [] };
}

function startBackupTimer(ms: number, deadlineMs: number): { expired: Promise<never>; clear: () => void } {
  const timer: { id: NodeJS.Timeout | undefined } = { id: undefined };
  const expired = new Promise<never>((_resolve, reject) => {
    timer.id = setTimeout(() => {
      reject(queryTimeoutError(deadlineMs));
    }, ms);
  });
  return {
    expired,
    clear: () => {
      clearTimeout(timer.id);
    },
  };
}

async function raceAgainstBackupTimer(call: Promise<CallRows>, deadlineMs: number): Promise<CallRows> {
  const backup = startBackupTimer(deadlineMs + BACKUP_TIMEOUT_SLACK_MS, deadlineMs);
  try {
    return await Promise.race([call, backup.expired]);
  } finally {
    backup.clear();
  }
}

function translateCallError(error: unknown, request: QueryRequest, deadlineMs: number): unknown {
  request.signal?.throwIfAborted();
  return /deadline exceeded/iu.test(errorMessage(error)) ? queryTimeoutError(deadlineMs) : error;
}

export async function callWithDeadline(request: QueryRequest, options: GrpcCallOptions, messages: Record<string, unknown>[]): Promise<CallRows> {
  const call = isStreamingMethod(options.method) ? streamRows(options, messages) : unaryRows(options, messages);
  try {
    return await raceAgainstBackupTimer(call, options.deadlineMs);
  } catch (error) {
    throw translateCallError(error, request, options.deadlineMs);
  }
}
