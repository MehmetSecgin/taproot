import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryOutcome } from '../src/core/execute-query.js';
import { presentQueryOutcome, queryFailureError } from '../src/commands/query-present.js';
import { setPluck } from '../src/core/output.js';

function successOutcome(overrides: Partial<Extract<QueryOutcome, { ok: true }>> = {}): QueryOutcome {
  return {
    ok: true,
    data: {
      columns: ['id', 'name'],
      rows: [[1, 'alpha']],
      rowsForm: 'array',
      datasource: 'qa-fake',
      plugin: 'fake',
      classification: 'success',
    },
    meta: {
      runId: 'run-1',
      resolved: { source: 'store', env: 'qa', service: 'fake', engine: 'fake', target: 'host', database: 'db' },
      phases: { resolveMs: 1, connectMs: 2, executeMs: 3, totalMs: 6 },
      timings: { durationMs: 3 },
    },
    ...overrides,
  } as QueryOutcome;
}

afterEach(() => {
  vi.restoreAllMocks();
  setPluck(undefined);
});

describe('presentQueryOutcome', () => {
  it('prints the full envelope with the request id', () => {
    // arrange
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });

    // act
    presentQueryOutcome(successOutcome(), 'req-9');

    // assert
    const envelope = JSON.parse(writes.join(''));
    expect(envelope.ok).toBe(true);
    expect(envelope.data.columns).toEqual(['id', 'name']);
    expect(envelope.meta.requestId).toBe('req-9');
    expect(envelope.meta.runId).toBe('run-1');
  });

  it('honours a pluck path', () => {
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });
    setPluck('data.columns');
    presentQueryOutcome(successOutcome(), 'req-9');
    expect(JSON.parse(writes.join(''))).toEqual(['id', 'name']);
  });
});

describe('presentQueryOutcome on failure', () => {
  it('throws a prefixed error carrying details and meta', () => {
    const call = () =>
      presentQueryOutcome({ ok: false, code: 'ACCESS_DENIED', message: 'access denied', details: { hint: 'check creds' }, meta: { runId: 'run-2' } }, 'req-9');
    expect(call).toThrowError('ACCESS_DENIED: access denied');
    try {
      call();
    } catch (error) {
      const typed = error as Error & { details?: Record<string, unknown>; meta?: Record<string, unknown> };
      expect(typed.details).toEqual({ hint: 'check creds' });
      expect(typed.meta).toMatchObject({ runId: 'run-2', requestId: 'req-9' });
    }
  });
});

describe('queryFailureError', () => {
  it('does not prefix a message that already carries its code', () => {
    const error = queryFailureError({ ok: false, code: 'BAD_INPUT', message: 'BAD_INPUT: broken pair', meta: {} });
    expect(error.message).toBe('BAD_INPUT: broken pair');
  });

  it('prefixes a message that does not carry its code', () => {
    const error = queryFailureError({ ok: false, code: 'BAD_INPUT', message: 'broken pair', meta: {} });
    expect(error.message).toBe('BAD_INPUT: broken pair');
  });
});
