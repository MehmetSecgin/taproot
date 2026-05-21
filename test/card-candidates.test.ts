import { describe, expect, it } from 'vitest';
import { __test__ } from '../src/commands/card.js';
import type { RunsLedgerEntry } from '../src/core/runs-ledger.js';

const { aggregateCandidates } = __test__;

function entry(overrides: Partial<RunsLedgerEntry>): RunsLedgerEntry {
  return {
    runId: overrides.runId || 'r-x',
    sessionId: overrides.sessionId,
    ts: '2026-05-14T12:00:00.000Z',
    datasource: 'qa-develop-orders',
    fingerprint: 'fp_aaa',
    sql: 'SELECT id FROM users WHERE id = :id',
    normalizedSql: 'select id from users where id = :id',
    tables: ['users'],
    schemaSnapshotRefs: [],
    capability: 'executeRead',
    outcomeCode: 'ok',
    columns: ['id'],
    ...overrides,
  } as RunsLedgerEntry;
}

describe('aggregateCandidates', () => {
  it('groups by fingerprint and counts distinct sessions', () => {
    const entries: RunsLedgerEntry[] = [
      entry({ runId: 'r1', sessionId: 's1' }),
      entry({ runId: 'r2', sessionId: 's2' }),
      entry({ runId: 'r3', sessionId: 's1' }),
      entry({ runId: 'r4', sessionId: 's3', fingerprint: 'fp_other', sql: 'SELECT 1' }),
    ];
    const out = aggregateCandidates(entries, { minSessions: 2 });
    expect(out).toHaveLength(1);
    expect(out[0].fingerprint).toBe('fp_aaa');
    expect(out[0].sessions.size).toBe(2);
    expect(out[0].runIds).toHaveLength(3);
  });

  it('drops failures and empty SQL', () => {
    const entries = [
      entry({ runId: 'r1', sessionId: 's1', outcomeCode: 'error' }),
      entry({ runId: 'r2', sessionId: 's2', sql: '' }),
      entry({ runId: 'r3', sessionId: 's3' }),
    ];
    const out = aggregateCandidates(entries, { minSessions: 1 });
    expect(out).toHaveLength(1);
    expect(out[0].sample.runId).toBe('r3');
  });

  it('filters by datasource when provided', () => {
    const entries = [
      entry({ runId: 'r1', sessionId: 's1', datasource: 'a' }),
      entry({ runId: 'r2', sessionId: 's2', datasource: 'b', fingerprint: 'fp_b' }),
    ];
    const out = aggregateCandidates(entries, { minSessions: 1, datasource: 'a' });
    expect(out.map((c) => c.datasource)).toEqual(['a']);
  });

  it('falls back to runId when sessionId missing', () => {
    const entries = [
      entry({ runId: 'r1' }),
      entry({ runId: 'r2' }),
      entry({ runId: 'r3' }),
    ];
    const out = aggregateCandidates(entries, { minSessions: 3 });
    expect(out[0].sessions.size).toBe(3);
  });

  it('respects minSessions threshold', () => {
    const entries = [entry({ runId: 'r1', sessionId: 's1' })];
    expect(aggregateCandidates(entries, { minSessions: 2 })).toHaveLength(0);
    expect(aggregateCandidates(entries, { minSessions: 1 })).toHaveLength(1);
  });
});
