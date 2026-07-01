import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
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

function setupState() {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-config-'));
  const configDir = path.join(stateRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'datasources.json'), '[]\n');
  fs.writeFileSync(path.join(configDir, 'deterministic-config.json'), '{}\n');
  return { stateRoot, configDir, env: { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key' } };
}

function datasources(configDir: string): string {
  return path.join(configDir, 'datasources.json');
}

describe('taproot config snapshots', () => {
  it('snapshots, detects drift, and restores', () => {
    // arrange
    const { configDir, env } = setupState();
    const snap = runCli(['--json', 'config', 'snapshot', '--label', 'known-good'], env);
    expect(snap.status).toBe(0);
    const snapId = JSON.parse(snap.stdout).snapshot.id as string;
    expect(snapId).toBeTruthy();

    // act — mutate config, then check status
    fs.writeFileSync(datasources(configDir), '[{"name":"rogue"}]\n');
    const status = runCli(['--json', 'config', 'status'], env);

    // assert — drift detected on the changed file
    expect(status.status).toBe(0);
    const report = JSON.parse(status.stdout);
    expect(report.drifted).toBe(true);
    expect(report.baseline).toBe(snapId);
    expect(report.changes).toContainEqual({ file: 'datasources.json', status: 'changed' });

    // act — restore
    const restore = runCli(['--json', 'config', 'restore', '--label', 'known-good'], env);

    // assert — file content is back and default status (HEAD) is clean after restore
    expect(restore.status).toBe(0);
    expect(fs.readFileSync(datasources(configDir), 'utf8')).toBe('[]\n');
    const after = JSON.parse(runCli(['--json', 'config', 'status'], env).stdout);
    expect(after.baseline).toBe(snapId);
    expect(after.drifted).toBe(false);
  });

  it('takes a pre-restore safety snapshot by default', () => {
    // arrange
    const { configDir, env } = setupState();
    runCli(['config', 'snapshot', '--label', 'base'], env);
    fs.writeFileSync(datasources(configDir), '[{"name":"changed"}]\n');

    // act
    const restore = runCli(['--json', 'config', 'restore', '--latest'], env);

    // assert — restore reports a backup id and it appears in the list
    const result = JSON.parse(restore.stdout);
    expect(result.backup).toBeTruthy();
    const list = JSON.parse(runCli(['--json', 'config', 'list'], env).stdout);
    expect(list.snapshots.some((s: { label?: string }) => s.label === 'pre-restore')).toBe(true);
  });

  it('reports a line-level diff for changed files', () => {
    // arrange
    const { configDir, env } = setupState();
    runCli(['config', 'snapshot'], env);
    fs.writeFileSync(datasources(configDir), '[{"name":"added-line"}]\n');

    // act
    const diff = JSON.parse(runCli(['--json', 'config', 'diff'], env).stdout);

    // assert
    const fileDiff = diff.files.find((f: { file: string }) => f.file === 'datasources.json');
    expect(fileDiff.status).toBe('changed');
    expect(fileDiff.added + fileDiff.removed).toBeGreaterThan(0);
  });
});
