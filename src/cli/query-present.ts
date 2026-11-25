import type { QueryOutcome, QueryOutcomeMeta } from '../core/query-types.js';
import { isList, isRecord } from '../core/json-shapes.js';
import { printJson } from '../core/output.js';
import { errorWithCodePrefix, replyFailure } from './query-reply.js';
import type { QueryReply } from './query-reply.js';

export function queryFailureError(outcome: Extract<QueryOutcome, { ok: false }>): Error {
  const error = errorWithCodePrefix(outcome);
  error.meta = outcome.meta;
  return error;
}

function isEmptyMap(value: unknown): boolean {
  return !isRecord(value) || Object.keys(value).length === 0;
}

export function trimQueryJsonEnvelope<Envelope extends Record<string, unknown>>(envelope: Envelope): Envelope {
  const { data, meta } = envelope;
  if (isRecord(data) && isList(data.warnings) && data.warnings.length === 0) {
    delete data.warnings;
  }
  if (isRecord(meta) && isRecord(meta.schemaContext) && isEmptyMap(meta.schemaContext.tables)) {
    delete meta.schemaContext;
  }
  return envelope;
}

function printQuerySuccess(success: { data: Record<string, unknown>; meta: QueryOutcomeMeta; requestId: string }): void {
  const { data, meta, requestId } = success;
  printJson(trimQueryJsonEnvelope({ ok: true, data, meta: { ...meta, requestId } }));
}

export function presentQueryOutcome(outcome: QueryOutcome, requestId: string): void {
  if (!outcome.ok) {
    throw queryFailureError({ ...outcome, meta: { ...outcome.meta, requestId } });
  }
  printQuerySuccess({ data: outcome.data, meta: outcome.meta, requestId });
}

export function presentQueryReply(reply: QueryReply): void {
  if (!reply.ok) {
    throw queryFailureError({ ok: false, ...replyFailure(reply), meta: { ...reply.meta, requestId: reply.requestId } });
  }
  printQuerySuccess({ data: reply.data ?? {}, meta: reply.meta ?? {}, requestId: reply.requestId });
}
