import type { QueryOutcome, QueryOutcomeMeta, QuerySuccessData } from '../core/execute-query.js';
import { printJson, trimQueryJsonEnvelope } from '../core/output.js';
import type { RpcResponse } from '../daemon/types.js';

export type DaemonReply = Pick<RpcResponse, 'ok' | 'requestId' | 'data' | 'error'> & { meta?: QueryOutcomeMeta };

export function queryFailureError(outcome: Extract<QueryOutcome, { ok: false }>): Error {
  const prefixed = outcome.message.toLowerCase().startsWith(`${outcome.code.toLowerCase()}:`)
    ? outcome.message
    : `${outcome.code}: ${outcome.message}`;
  const error = new Error(prefixed) as Error & { details?: unknown; meta?: unknown };
  error.details = outcome.details;
  error.meta = outcome.meta;
  return error;
}

export function presentQueryOutcome(outcome: QueryOutcome, requestId: string): void {
  if (!outcome.ok) throw queryFailureError({ ...outcome, meta: { ...outcome.meta, requestId } });
  const { data, meta } = outcome;
  printJson(trimQueryJsonEnvelope({ ok: true, data, meta: { ...meta, requestId } }));
}

export function outcomeReply(outcome: QueryOutcome, requestId: string): DaemonReply {
  if (outcome.ok) return { ok: true, requestId, data: outcome.data as unknown as Record<string, unknown>, meta: outcome.meta };
  const details = outcome.details as Record<string, unknown> | undefined;
  return { ok: false, requestId, error: { code: outcome.code, message: outcome.message, details }, meta: outcome.meta };
}

export function daemonReplyError(reply: DaemonReply): Error {
  return queryFailureError({
    ok: false,
    code: reply.error?.code || 'GENERIC',
    message: reply.error?.message || 'daemon request failed',
    details: reply.error?.details,
    meta: { ...reply.meta, requestId: reply.requestId },
  });
}

export function presentQueryReply(reply: DaemonReply): void {
  if (!reply.ok) throw daemonReplyError(reply);
  presentQueryOutcome({ ok: true, data: (reply.data || {}) as unknown as QuerySuccessData, meta: reply.meta || {} }, reply.requestId);
}

export function replyData(reply: DaemonReply): Record<string, unknown> {
  if (!reply.ok) throw daemonReplyError(reply);
  return reply.data || {};
}
