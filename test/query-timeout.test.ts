import { setTimeout as delay } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { RUNTIME_CONSTANTS } from '../src/core/constants.js';
import { parseTimeoutMs, queryBudgetMs, queryTimeoutError, withQueryTimeout } from '../src/core/query-timeout.js';

describe('query timeout helpers', () => {
  it('uses the fallback timeout when omitted', () => {
    expect(parseTimeoutMs(undefined, 5000)).toBe(5000);
  });

  it('parses an explicit timeout override', () => {
    expect(parseTimeoutMs('4500', 5000)).toBe(4500);
  });

  it('rejects invalid timeout values', () => {
    expect(() => parseTimeoutMs('0', 5000)).toThrow(/BAD_INPUT/u);
    expect(() => parseTimeoutMs('-1', 5000)).toThrow(/BAD_INPUT/u);
    expect(() => parseTimeoutMs('abc', 5000)).toThrow(/BAD_INPUT/u);
  });

  it('echoes the effective timeout and suggests narrowing the scan', () => {
    const { message } = queryTimeoutError(15_000);
    expect(message).toContain('15000ms');
    expect(message).toContain('--timeout');
    expect(message).toMatch(/partition|predicate/iu);
  });

  it('fails fast when a query exceeds the timeout', async () => {
    await expect(
      withQueryTimeout({
        timeoutMs: 25,
        signal: undefined,
        run: async () => {
          await delay(100);
          return 'late';
        },
      }),
    ).rejects.toThrow(queryTimeoutError(25).message);
  });

  it('stops the run when the caller aborts before the timeout', async () => {
    // arrange
    const caller = new AbortController();
    const runSignals: AbortSignal[] = [];
    const pending = withQueryTimeout({
      timeoutMs: 5000,
      signal: caller.signal,
      run: async (signal) => {
        runSignals.push(signal);
        return delay(60_000, null, { signal });
      },
    });

    // act
    caller.abort(new Error('client disconnected'));

    // assert
    await expect(pending).rejects.toThrow('client disconnected');
    expect(runSignals.map((signal) => signal.aborted)).toStrictEqual([true]);
  });

  it('lets the client wait for queue wait, connector preflight and execution', () => {
    const preflightMs = RUNTIME_CONSTANTS.connector.preflightTimeoutMs;
    expect(queryBudgetMs(1000)).toBe(1000 + preflightMs + 1000);
    expect(queryBudgetMs(preflightMs * 2)).toBe(preflightMs * 6);
  });
});
