import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueryOutcome } from '../src/core/query-types.js';
import { presentQueryOutcome, queryFailureError } from '../src/cli/query-present.js';
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
      sessionId: 'session-1',
      resolved: { source: 'store', env: 'qa', service: 'fake', engine: 'fake', target: 'host', database: 'db' },
      phases: { resolveMs: 1, connectMs: 2, executeMs: 3, totalMs: 6 },
      timings: { durationMs: 3 },
    },
    ...overrides,
  };
}

function captureStdout(): string[] {
  const writes: string[] = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    writes.push(String(chunk));
    return true;
  });
  return writes;
}

function presentAccessDenied(): void {
  presentQueryOutcome(
    { ok: false, code: 'ACCESS_DENIED', message: 'access denied', details: { hint: 'check creds' }, meta: { sessionId: 'session-2' } },
    'req-9',
  );
}

function thrownBy(run: () => void): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to throw');
}

describe('presenting a query outcome', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setPluck(undefined);
  });

  it('prints the full envelope with the request id', () => {
    // arrange
    const writes = captureStdout();

    // act
    presentQueryOutcome(successOutcome(), 'req-9');

    // assert
    expect(JSON.parse(writes.join(''))).toMatchObject({
      ok: true,
      data: { columns: ['id', 'name'] },
      meta: { requestId: 'req-9', sessionId: 'session-1' },
    });
  });

  it('honours a pluck path', () => {
    const writes = captureStdout();
    setPluck('data.columns');
    presentQueryOutcome(successOutcome(), 'req-9');
    expect(JSON.parse(writes.join(''))).toStrictEqual(['id', 'name']);
  });
});

describe('presenting a failed query outcome', () => {
  it('throws a prefixed error carrying details and meta', () => {
    expect(presentAccessDenied).toThrow('ACCESS_DENIED: access denied');
    expect(thrownBy(presentAccessDenied)).toMatchObject({
      details: { hint: 'check creds' },
      meta: { sessionId: 'session-2', requestId: 'req-9' },
    });
  });
});

describe('building a query failure error', () => {
  it('does not prefix a message that already carries its code', () => {
    const error = queryFailureError({ ok: false, code: 'BAD_INPUT', message: 'BAD_INPUT: broken pair', meta: {} });
    expect(error.message).toBe('BAD_INPUT: broken pair');
  });

  it('prefixes a message that does not carry its code', () => {
    const error = queryFailureError({ ok: false, code: 'BAD_INPUT', message: 'broken pair', meta: {} });
    expect(error.message).toBe('BAD_INPUT: broken pair');
  });
});
