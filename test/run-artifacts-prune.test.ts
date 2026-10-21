import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pruneRunArtifacts, pruneRunArtifactsDaily, writeRunSummary } from '../src/core/artifacts.js';
import type { QueryResult } from '../src/types/core.js';

function makeRun(runsDir: string, name: string, ageHours: number): string {
  const runDir = path.join(runsDir, name);
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'summary.json'), '{}\n');
  const stamp = new Date(Date.now() - ageHours * 3600 * 1000);
  fs.utimesSync(runDir, stamp, stamp);
  return runDir;
}

describe('run artifact retention', () => {
  it('removes run directories older than the cutoff and keeps newer ones', () => {
    // arrange
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-runs-prune-'));
    makeRun(runsDir, '20260101-000000-qa-orders', 400);
    makeRun(runsDir, '20260601-000000-qa-orders', 200);
    makeRun(runsDir, '20260729-000000-qa-orders', 1);

    // act
    const out = pruneRunArtifacts(runsDir, Date.now() - 168 * 3600 * 1000);

    // assert
    expect(out).toEqual({ before: 3, after: 1 });
    expect(fs.readdirSync(runsDir)).toEqual(['20260729-000000-qa-orders']);
  });

  it('keeps every run when all are newer than the cutoff', () => {
    // arrange
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-runs-prune-'));
    makeRun(runsDir, '20260729-000000-qa-orders', 1);
    makeRun(runsDir, '20260729-010000-qa-orders', 2);

    // act
    const out = pruneRunArtifacts(runsDir, Date.now() - 168 * 3600 * 1000);

    // assert
    expect(out).toEqual({ before: 2, after: 2 });
    expect(fs.readdirSync(runsDir)).toHaveLength(2);
  });

  it('returns zero counts when the runs directory does not exist', () => {
    // arrange
    const missing = path.join(os.tmpdir(), 'taproot-runs-absent-does-not-exist');

    // act
    const out = pruneRunArtifacts(missing, Date.now());

    // assert
    expect(out).toEqual({ before: 0, after: 0 });
  });

  it('prunes old runs at most once per day', () => {
    // arrange
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-runs-daily-'));
    makeRun(runsDir, '20260101-000000-qa-orders', 400);

    // act
    pruneRunArtifactsDaily(runsDir);
    makeRun(runsDir, '20260102-000000-qa-orders', 400);
    pruneRunArtifactsDaily(runsDir);

    // assert
    expect(fs.readdirSync(runsDir).sort()).toEqual(['.last-prune', '20260102-000000-qa-orders']);

    // act
    pruneRunArtifactsDaily(runsDir, Date.now() + 25 * 3600 * 1000);

    // assert
    expect(fs.readdirSync(runsDir)).toEqual(['.last-prune']);
  });

  it('caps the rows stored in summary.json and records the full row count', () => {
    // arrange
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-runs-cap-'));
    const rows = Array.from({ length: 1500 }, (_, id) => ({ id }));
    const result = { runId: 'r1', result: { columns: ['id'], rows } } as unknown as QueryResult;

    // act
    writeRunSummary(runDir, result);

    // assert
    const stored = JSON.parse(fs.readFileSync(path.join(runDir, 'summary.json'), 'utf8'));
    expect(stored.result.rows).toHaveLength(1000);
    expect(stored.result.rowCount).toBe(1500);
    expect(stored.result.truncated).toBe(true);
    expect(result.result.rows).toHaveLength(1500);
  });
});
