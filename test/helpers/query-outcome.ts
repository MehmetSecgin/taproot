import type { QueryOutcome } from '../../src/core/query-types.js';

type SucceededQuery = Extract<QueryOutcome, { ok: true }>;
type FailedQuery = Extract<QueryOutcome, { ok: false }>;

export function expectSuccess(outcome: QueryOutcome): SucceededQuery {
  if (!outcome.ok) {
    throw new Error('expected success');
  }
  return outcome;
}

export function expectFailure(outcome: QueryOutcome): FailedQuery {
  if (outcome.ok) {
    throw new Error('expected failure');
  }
  return outcome;
}
