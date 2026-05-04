import { describe, expect, it } from 'vitest';
import { parseTimeoutMs, queryTimeoutError, withQueryTimeout } from '../src/core/query-timeout.js';

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

  it('fails fast when a query exceeds the timeout', async () => {
    await expect(
      withQueryTimeout({
        timeoutMs: 25,
        run: async () => {
          await new Promise((resolve) => setTimeout(resolve, 100));
          return 'late';
        },
      }),
    ).rejects.toThrow(queryTimeoutError(25).message);
  });
});
