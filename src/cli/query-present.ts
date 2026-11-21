import type { QueryOutcome, QueryOutcomeMeta, QuerySuccessData } from '../core/execute-query.js';
import { printJson, trimQueryJsonEnvelope } from '../core/output.js';
import type { RpcResponse } from '../daemon/types.js';

export type QueryReply = Pick<RpcResponse, 'ok' | 'requestId' | 'data' | 'error'> & { meta?: QueryOutcomeMeta };

type CodedError = Error & { details?: unknown; meta?: unknown };

function codedError(failure: { code: string; message: string; details?: unknown }): CodedError {
  const prefixed = failure.message.toLowerCase().startsWith(`${failure.code.toLowerCase()}:`)
    ? failure.message
    : `${failure.code}: ${failure.message}`;
  const error: CodedError = new Error(prefixed);
  error.details = failure.details;
  return error;
}

export function queryFailureError(outcome: Extract<QueryOutcome, { ok: false }>): Error {
  const error = codedError(outcome);
  error.meta = outcome.meta;
  return error;
}

export function presentQueryOutcome(outcome: QueryOutcome, requestId: string): void {
  if (!outcome.ok) throw queryFailureError({ ...outcome, meta: { ...outcome.meta, requestId } });
  const { data, meta } = outcome;
  printJson(trimQueryJsonEnvelope({ ok: true, data, meta: { ...meta, requestId } }));
}

export function outcomeReply(outcome: QueryOutcome, requestId: string): QueryReply {
  if (outcome.ok) return { ok: true, requestId, data: outcome.data as unknown as Record<string, unknown>, meta: outcome.meta };
  const details = outcome.details as Record<string, unknown> | undefined;
  return { ok: false, requestId, error: { code: outcome.code, message: outcome.message, details }, meta: outcome.meta };
}

function replyFailure(reply: QueryReply): { code: string; message: string; details?: unknown } {
  return { code: reply.error?.code || 'GENERIC', message: reply.error?.message || 'daemon request failed', details: reply.error?.details };
}

export function presentQueryReply(reply: QueryReply): void {
  if (!reply.ok) throw queryFailureError({ ok: false, ...replyFailure(reply), meta: { ...reply.meta, requestId: reply.requestId } });
  presentQueryOutcome({ ok: true, data: (reply.data || {}) as unknown as QuerySuccessData, meta: reply.meta || {} }, reply.requestId);
}

export function replyData(reply: QueryReply): Record<string, unknown> {
  if (!reply.ok) throw codedError(replyFailure(reply));
  return reply.data || {};
}
