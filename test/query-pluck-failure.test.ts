import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function setupStateRoot(): string {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-pluck-'));
  const configDir = path.join(stateRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'datasources.json'),
    JSON.stringify([
      {
        name: 'prod-orders',
        kind: 'teleport-mysql',
        env: 'prod',
        service: 'orders',
        tags: [],
        connection: { target: 'orders-tidb', database: 'orders' },
        credentialRef: 'prod:orders',
        connectors: [],
        policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
        resolverHints: { dbUser: 'reader' },
        updatedAt: new Date().toISOString(),
        confidence: 0.9,
      },
    ]),
  );
  fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');
  return stateRoot;
}

function runCli(args: string[], env: Record<string, string> = {}) {
  const distCli = path.join(process.cwd(), 'dist', 'index.js');
  return spawnSync(process.execPath, [distCli, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('query failure with --pluck', () => {
  it('exits non-zero and routes the error to stderr (not the plucked value on stdout)', () => {
    const stateRoot = setupStateRoot();
    const out = runCli(
      ['--json', 'query', '--datasource', 'prod-orders', '--sql', 'SELECT 1 AS ok', '--pluck', 'data.rows'],
      { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key', TAPROOT_FORCE_DIRECT: '1', PATH: '' },
    );
    // act / assert
    expect(out.status).not.toBe(0);
    expect(out.stdout.trim()).toBe('');
    const parsed = JSON.parse(out.stderr);
    expect(parsed.code).toBeTruthy();
    expect(parsed.message).toBeTruthy();
    expect(parsed).not.toHaveProperty('ok');
    expect(parsed).not.toHaveProperty('meta');
  });

  it('prints one CODE: message line to stderr in jsonl mode', () => {
    const stateRoot = setupStateRoot();
    const out = runCli(
      ['--jsonl', 'query', '--datasource', 'prod-orders', '--sql', 'SELECT 1 AS ok'],
      { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key', TAPROOT_FORCE_DIRECT: '1', PATH: '' },
    );
    // act / assert
    expect(out.status).not.toBe(0);
    expect(out.stdout).toBe('');
    const [first, ...rest] = out.stderr.trim().split('\n');
    expect(first).toMatch(/^[A-Z_]+: /);
    expect(rest.every((line) => line.startsWith('nextAction: '))).toBe(true);
  });

  it('keeps the full error envelope on stdout when --pluck is absent', () => {
    const stateRoot = setupStateRoot();
    const out = runCli(
      ['--json', 'query', '--datasource', 'prod-orders', '--sql', 'SELECT 1 AS ok'],
      { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key', TAPROOT_FORCE_DIRECT: '1', PATH: '' },
    );
    // act / assert
    expect(out.status).not.toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.ok).toBe(false);
  });
});
