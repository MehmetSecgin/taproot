import type { QueryOutcome, QueryOutcomeMeta } from '../core/query-types.js';
import type { RpcResponse } from '../daemon/types.js';
import { nonEmptyOr } from '../core/text-presence.js';

export type QueryReply = Pick<RpcResponse, 'ok' | 'requestId' | 'data' | 'error'> & { meta?: QueryOutcomeMeta };

type FailureDescription = { code: string; message: string; details?: unknown };

type CodedError = Error & { details?: unknown; meta?: unknown };

export function errorWithCodePrefix(failure: FailureDescription): CodedError {
  const prefixedMessage = failure.message.toLowerCase().startsWith(`${failure.code.toLowerCase()}:`)
    ? failure.message
    : `${failure.code}: ${failure.message}`;
  const error: CodedError = new Error(prefixedMessage);
  error.details = failure.details;
  return error;
}

export function outcomeReply(outcome: QueryOutcome, requestId: string): QueryReply {
  if (outcome.ok) {
    return { ok: true, requestId, data: outcome.data, meta: outcome.meta };
  }
  return { ok: false, requestId, error: { code: outcome.code, message: outcome.message, details: outcome.details }, meta: outcome.meta };
}

export function replyFailure(reply: QueryReply): FailureDescription {
  return { code: nonEmptyOr(reply.error?.code, 'GENERIC'), message: nonEmptyOr(reply.error?.message, 'daemon request failed'), details: reply.error?.details };
}

export function dataOrThrow(reply: QueryReply): Record<string, unknown> {
  if (!reply.ok) {
    throw errorWithCodePrefix(replyFailure(reply));
  }
  return reply.data ?? {};
}
