import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('daemon stop', () => {
  it('reports running false when no daemon is running', () => {
    // arrange
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-daemon-stop-'));

    // act
    const out = spawnSync(process.execPath, [path.join(process.cwd(), 'dist', 'index.js'), 'daemon', 'stop'], {
      encoding: 'utf8',
      env: { ...process.env, TAPROOT_STATE_ROOT: stateRoot },
    });

    // assert
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ ok: true, data: { running: false } });
  });
});
