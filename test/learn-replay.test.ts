import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function runCli(args: string[], env: Record<string, string> = {}) {
  const distCli = path.join(process.cwd(), 'dist', 'index.js');
  return spawnSync(process.execPath, [distCli, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('learn replay', () => {
  it('replays run artifact in json mode', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-replay-'));
    const runId = '20260303-000000-test';
    const runDir = path.join(stateRoot, 'runs', runId);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(runDir, 'summary.json'),
      JSON.stringify({
        runId,
        datasource: 'qa-orders',
        plugin: 'mysql',
        capability: 'executeRead',
        result: { columns: ['ok'], rows: [{ ok: 1 }] },
        timings: { durationMs: 42 },
        classification: 'success',
      }),
    );
    fs.writeFileSync(path.join(runDir, 'events.log'), '2026-03-03T00:00:00Z started\n2026-03-03T00:00:01Z done\n');

    const out = runCli(['--json', 'learn', 'replay', '--run-id', runId], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-master-key',
    });
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.replayed).toBe(true);
    expect(parsed.runId).toBe(runId);
    expect(parsed.summary.datasource).toBe('qa-orders');
    expect(Array.isArray(parsed.events)).toBe(true);
    expect(parsed.events.length).toBe(2);
  });
});
