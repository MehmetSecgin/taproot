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
    expect(() => parseTimeoutMs('0', 5000)).toThrow(/BAD_INPUT/);
    expect(() => parseTimeoutMs('-1', 5000)).toThrow(/BAD_INPUT/);
    expect(() => parseTimeoutMs('abc', 5000)).toThrow(/BAD_INPUT/);
  });

  it('echoes the effective timeout and suggests narrowing the scan', () => {
    const message = queryTimeoutError(15000).message;
    expect(message).toContain('15000ms');
    expect(message).toContain('--timeout');
    expect(message).toMatch(/partition|predicate/i);
  });

  it('fails fast when a query exceeds the timeout', async () => {
    await expect(
      withQueryTimeout({
        timeoutMs: 25,
        signal: undefined,
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return 'late';
        },
      }),
    ).rejects.toThrow(queryTimeoutError(25).message);
  });

  it('stops the run when the caller aborts before the timeout', async () => {
    // arrange
    const caller = new AbortController();
    let runSignal: AbortSignal | undefined;
    const pending = withQueryTimeout({
      timeoutMs: 5_000,
      signal: caller.signal,
      run: (signal) => {
        runSignal = signal;
        return new Promise(() => undefined);
      },
    });

    // act
    caller.abort(new Error('client disconnected'));

    // assert
    await expect(pending).rejects.toThrow('client disconnected');
    expect(runSignal?.aborted).toBe(true);
  });

  it('lets the client wait for queue wait, connector preflight and execution', () => {
    const preflightMs = RUNTIME_CONSTANTS.connector.preflightTimeoutMs;
    expect(queryBudgetMs(1_000)).toBe(1_000 + preflightMs + 1_000);
    expect(queryBudgetMs(preflightMs * 2)).toBe(preflightMs * 6);
  });
});
