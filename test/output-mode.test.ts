import path from 'node:path';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { describe, expect, it } from 'vitest';

function runCli(args: string[], env: Record<string, string> = {}) {
  const distCli = path.join(process.cwd(), 'dist', 'index.js');
  return spawnSync(process.execPath, [distCli, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function setupStateRoot() {
  const stateRoot = path.join(os.tmpdir(), `taproot-output-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const configDir = path.join(stateRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'datasources.json'),
    JSON.stringify([
      {
        name: 'qa-orders',
        kind: 'mysql',
        env: 'qa',
        service: 'orders',
        tags: [],
        connection: { host: '127.0.0.1', port: 3306, database: 'orders' },
        credentialRef: 'qa:orders',
        connectors: [],
        policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
        resolverHints: {},
        updatedAt: new Date().toISOString(),
        confidence: 0.9,
      },
    ]),
  );
  return stateRoot;
}

describe('output mode contract', () => {
  it('shows datasource in human-readable mode by default', () => {
    const stateRoot = setupStateRoot();
    const out = runCli(['datasource', 'show', '--name', 'qa-orders'], { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key' });
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('Rows:');
    expect(out.stdout).toContain('qa-orders');
    expect(out.stdout.trim().startsWith('{')).toBe(false);
  });

  it('returns datasource as JSON only when --json is set', () => {
    const stateRoot = setupStateRoot();
    const out = runCli(['--json', 'datasource', 'show', '--name', 'qa-orders'], { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key' });
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.data.name).toBe('qa-orders');
  });

  it('shows cache and learn in human-readable mode by default', () => {
    const stateRoot = setupStateRoot();
    const env = { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key' };
    const cacheOut = runCli(['cache', 'show'], env);
    const learnOut = runCli(['learn', 'status'], env);
    expect(cacheOut.status).toBe(0);
    expect(learnOut.status).toBe(0);
    expect(cacheOut.stdout).toContain('Rows:');
    expect(learnOut.stdout).toContain('Rows:');
    expect(cacheOut.stdout.trim().startsWith('{')).toBe(false);
    expect(learnOut.stdout.trim().startsWith('{')).toBe(false);
  });

  it('shows creds in human-readable mode and JSON in --json mode', () => {
    const stateRoot = setupStateRoot();
    const env = { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key' };
    const setOut = runCli(['creds', 'set', '--ref', 'qa:orders', '--user', 'qa_user', '--password', 'secret'], env);
    expect(setOut.status).toBe(0);
    expect(setOut.stdout.toLowerCase()).toContain('saved credential ref');

    const showOut = runCli(['creds', 'show', '--ref', 'qa:orders'], env);
    expect(showOut.status).toBe(0);
    expect(showOut.stdout).toContain('Rows:');
    expect(showOut.stdout).toContain('qa_user');
    expect(showOut.stdout).toContain('[REDACTED]');

    const showJsonOut = runCli(['--json', 'creds', 'show', '--ref', 'qa:orders'], env);
    expect(showJsonOut.status).toBe(0);
    const parsed = JSON.parse(showJsonOut.stdout);
    expect(parsed.values.user).toBe('qa_user');
    expect(parsed.values.password).toBe('[REDACTED]');
  });
});
