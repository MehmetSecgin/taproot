import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
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

describe('bench argument guards', () => {
  function runCli(args: string[]) {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-bench-guards-'));
    return spawnSync(process.execPath, [path.join(process.cwd(), 'dist', 'index.js'), ...args], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: { ...process.env, TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key' },
    });
  }

  it('missing target fails as bad input', () => {
    const out = runCli(['--json', 'bench', '--sql', 'SELECT 1']);
    expect(out.status).toBe(2);
    const envelope = JSON.parse(out.stdout);
    expect(envelope.error.code).toBe('BAD_INPUT');
    expect(envelope.error.message).toContain('--datasource or --env+--service required');
  });

  it('scenario file without scenarios[] fails as bad input', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-bench-scenario-'));
    const file = path.join(dir, 'scenarios.json');
    fs.writeFileSync(file, JSON.stringify({ iterations: 3 }));
    const out = runCli(['--json', 'bench', '--scenario', file]);
    expect(out.status).toBe(2);
    const envelope = JSON.parse(out.stdout);
    expect(envelope.error.code).toBe('BAD_INPUT');
    expect(envelope.error.message).toContain('missing scenarios[]');
  });

  it('missing scenario file fails as bad input', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-bench-scenario-'));
    const out = runCli(['--json', 'bench', '--scenario', path.join(dir, 'absent.json')]);
    expect(out.status).toBe(2);
    const envelope = JSON.parse(out.stdout);
    expect(envelope.error.code).toBe('BAD_INPUT');
    expect(envelope.error.message).toContain('scenario file not found');
  });

  it('scenario file with malformed JSON fails as bad input', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-bench-scenario-'));
    const file = path.join(dir, 'scenarios.json');
    fs.writeFileSync(file, '{ not json');
    const out = runCli(['--json', 'bench', '--scenario', file]);
    expect(out.status).toBe(2);
    const envelope = JSON.parse(out.stdout);
    expect(envelope.error.code).toBe('BAD_INPUT');
    expect(envelope.error.message).toContain('is not valid JSON');
  });

  it('missing query fails as bad input', () => {
    const out = runCli(['--json', 'bench', '--datasource', 'qa-orders']);
    expect(out.status).toBe(2);
    const envelope = JSON.parse(out.stdout);
    expect(envelope.error.code).toBe('BAD_INPUT');
    expect(envelope.error.message).toContain('--sql required');
  });
});
