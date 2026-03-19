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
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-creds-'));
  const configDir = path.join(stateRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  return {
    env: {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
    },
  };
}

describe('credential lifecycle', () => {
  it('creds set stores credential', () => {
    const { env } = setupState();
    const out = runCli(['creds', 'set', '--ref', 'qa:orders', '--user', 'qa_user', '--password', 'secret123'], env);
    expect(out.status).toBe(0);
    expect(out.stdout.toLowerCase()).toContain('saved');
  });

  it('creds show redacts password in human mode', () => {
    const { env } = setupState();
    runCli(['creds', 'set', '--ref', 'qa:orders', '--user', 'qa_user', '--password', 'secret123'], env);
    const out = runCli(['creds', 'show', '--ref', 'qa:orders'], env);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('qa_user');
    expect(out.stdout).toContain('[REDACTED]');
    expect(out.stdout).not.toContain('secret123');
  });

  it('creds show redacts password in json mode', () => {
    const { env } = setupState();
    runCli(['creds', 'set', '--ref', 'qa:orders', '--user', 'qa_user', '--password', 'secret123'], env);
    const out = runCli(['--json', 'creds', 'show', '--ref', 'qa:orders'], env);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).values.password).toBe('[REDACTED]');
  });

  it('creds show redacts token', () => {
    const { env } = setupState();
    runCli(['creds', 'set', '--ref', 'x', '--token', 'mytoken'], env);
    const out = runCli(['creds', 'show', '--ref', 'x'], env);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('[REDACTED]');
    expect(out.stdout).not.toContain('mytoken');
  });

  it('creds unset removes credential', () => {
    const { env } = setupState();
    runCli(['creds', 'set', '--ref', 'qa:orders', '--user', 'qa_user', '--password', 'secret123'], env);
    const unsetOut = runCli(['creds', 'unset', '--ref', 'qa:orders'], env);
    const showOut = runCli(['creds', 'show', '--ref', 'qa:orders'], env);
    expect(unsetOut.status).toBe(0);
    expect(showOut.status).toBe(1);
  });

  it('creds set with kv pairs', () => {
    const { env } = setupState();
    runCli(['creds', 'set', '--ref', 'x', '--kv', 'role=admin', '--kv', 'region=us-east-1'], env);
    const out = runCli(['creds', 'show', '--ref', 'x'], env);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('admin');
    expect(out.stdout).toContain('us-east-1');
  });

  it('creds set with connector commands', () => {
    const { env } = setupState();
    runCli(['creds', 'set', '--ref', 'x', '--status-command', 'tsh status', '--connect-command', 'tsh db login'], env);
    const out = runCli(['creds', 'show', '--ref', 'x'], env);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('tsh status');
    expect(out.stdout).toContain('tsh db login');
  });
});
