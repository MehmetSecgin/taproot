import type { QueryOutcome } from '../core/execute-query.js';
import { getOutputOptions, printJson, rowToObject, trimQueryJsonEnvelope } from '../core/output.js';

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
  const { jsonl, pluck } = getOutputOptions();
  if (jsonl && !pluck) printJson(data.rows.map((row) => rowToObject(data.columns, row)));
  else printJson(trimQueryJsonEnvelope({ ok: true, data, meta: { ...meta, requestId } }));
}
