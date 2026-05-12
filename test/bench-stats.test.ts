import { describe, expect, it } from 'vitest';
import { phaseStats, percentile, summarize, type IterationSample } from '../src/commands/bench.js';

describe('bench phase statistics', () => {
  it('returns zeros for empty input', () => {
    const stats = phaseStats([]);
    expect(stats).toEqual({ avg: 0, p50: 0, p95: 0, min: 0, max: 0 });
  });

  it('computes avg/min/max correctly', () => {
    const stats = phaseStats([10, 20, 30]);
    expect(stats.avg).toBe(20);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(30);
  });

  it('computes p50 and p95 across 100 samples deterministically', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    const stats = phaseStats(values);
    expect(stats.p50).toBe(50);
    expect(stats.p95).toBe(95);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(100);
  });

  it('percentile clamps to last element', () => {
    expect(percentile([1, 2, 3, 4, 5], 100)).toBe(5);
    expect(percentile([], 50)).toBe(0);
  });

  it('summarize groups successes/failures and aggregates errors', () => {
    const samples: IterationSample[] = [
      { scenario: 's1', ok: true, totalMs: 100, resolveMs: 10, connectMs: 20, executeMs: 70 },
      { scenario: 's1', ok: true, totalMs: 200, resolveMs: 20, connectMs: 40, executeMs: 140 },
      { scenario: 's1', ok: false, totalMs: 50, errorCode: 'CONNECTIVITY' },
      { scenario: 's1', ok: false, totalMs: 60, errorCode: 'CONNECTIVITY' },
      { scenario: 's1', ok: false, totalMs: 70, errorCode: 'ACCESS_DENIED' },
    ];
    const summary = summarize(samples, 's1');
    expect(summary.iterations).toBe(5);
    expect(summary.successes).toBe(2);
    expect(summary.failures).toBe(3);
    expect(summary.total.avg).toBe(150);
    expect(summary.resolve.avg).toBe(15);
    expect(summary.execute.avg).toBe(105);
    expect(summary.errors).toEqual({ CONNECTIVITY: 2, ACCESS_DENIED: 1 });
  });
});
