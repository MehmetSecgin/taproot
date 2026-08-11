import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppContext } from '../src/core/app.js';
import type { QueryOutcome } from '../src/core/execute-query.js';
import type { ProgressReporter } from '../src/core/progress.js';
import { presentQueryOutcome, queryFailureError } from '../src/commands/query-present.js';

function fakeProgress(): ProgressReporter & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    update: (t) => calls.push(`update:${t}`),
    succeed: (t) => calls.push(`succeed:${t}`),
    warn: (t) => calls.push(`warn:${t}`),
    fail: (t) => calls.push(`fail:${t}`),
    stop: () => calls.push('stop'),
  };
}

function ctxWith(jsonMode: boolean, verbose = false): AppContext {
  return { jsonMode, verbose } as unknown as AppContext;
}

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
});

describe('presentQueryOutcome in json mode', () => {
  it('prints the full envelope with the request id', () => {
    // arrange
    const writes: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      writes.push(String(chunk));
      return true;
    });

    // act
    presentQueryOutcome({
      outcome: successOutcome(),
      ctx: ctxWith(true),
      opts: {},
      progress: fakeProgress(),
      requestId: 'req-9',
    });

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
    presentQueryOutcome({
      outcome: successOutcome(),
      ctx: ctxWith(true),
      opts: { pluck: 'data.columns' },
      progress: fakeProgress(),
      requestId: 'req-9',
    });
    expect(JSON.parse(writes.join(''))).toEqual(['id', 'name']);
  });

  it('prints no table in json mode', () => {
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    presentQueryOutcome({
      outcome: successOutcome(),
      ctx: ctxWith(true),
      opts: {},
      progress: fakeProgress(),
      requestId: 'req-9',
    });
    expect(log).not.toHaveBeenCalled();
  });
});

describe('presentQueryOutcome on a terminal', () => {
  it('prints the resolved line above the table', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    presentQueryOutcome({
      outcome: successOutcome(),
      ctx: ctxWith(false),
      opts: {},
      progress: fakeProgress(),
      requestId: 'req-9',
    });
    const first = String(log.mock.calls[0][0]);
    expect(first).toContain('resolved via=store');
    expect(first).toContain('env=qa');
    expect(first).toContain('engine=fake');
  });

  it('reports warnings through the progress reporter', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const progress = fakeProgress();
    const outcome = successOutcome();
    if (!outcome.ok) throw new Error('unreachable');
    outcome.data.warnings = ['partition scan without predicate'];
    presentQueryOutcome({ outcome, ctx: ctxWith(false), opts: {}, progress, requestId: 'req-9' });
    expect(progress.calls).toContain('warn:warnings: partition scan without predicate');
  });

  it('includes phase timings in the success line only when verbose', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const quiet = fakeProgress();
    presentQueryOutcome({ outcome: successOutcome(), ctx: ctxWith(false), opts: {}, progress: quiet, requestId: 'r' });
    expect(quiet.calls.join(' ')).not.toContain('resolve 1ms');

    const loud = fakeProgress();
    presentQueryOutcome({ outcome: successOutcome(), ctx: ctxWith(false, true), opts: {}, progress: loud, requestId: 'r' });
    expect(loud.calls.join(' ')).toContain('resolve 1ms');
  });
});

describe('presentQueryOutcome on failure', () => {
  it('throws a prefixed error carrying details and meta', () => {
    const progress = fakeProgress();
    const call = () =>
      presentQueryOutcome({
        outcome: { ok: false, code: 'ACCESS_DENIED', message: 'access denied', details: { hint: 'check creds' }, meta: { runId: 'run-2' } },
        ctx: ctxWith(true),
        opts: {},
        progress,
        requestId: 'req-9',
      });
    expect(call).toThrowError('ACCESS_DENIED: access denied');
    expect(progress.calls).toContain('fail:query failed (ACCESS_DENIED)');
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
