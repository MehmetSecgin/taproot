import { describe, expect, it } from 'vitest';
import { QueryLimiter } from '../src/daemon/query-limiter.js';

describe('query limiter', () => {
  it('rejects when queue is full', async () => {
    const limiter = new QueryLimiter(1, 1);
    const releaseA = await limiter.acquire();
    const waiter = limiter.acquire();
    await expect(limiter.acquire()).rejects.toThrow(/OVERLOADED/);
    releaseA();
    const releaseB = await waiter;
    releaseB();
  });

  it('promotes queued request on release', async () => {
    const limiter = new QueryLimiter(1, 2);
    const releaseA = await limiter.acquire();
    const waiter = limiter.acquire();
    expect(limiter.stats().queued).toBe(1);
    releaseA();
    const releaseB = await waiter;
    expect(limiter.stats().inFlight).toBe(1);
    releaseB();
    expect(limiter.stats().inFlight).toBe(0);
  });
});
