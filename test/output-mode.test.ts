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
  it('prints JSON by default', () => {
    const stateRoot = setupStateRoot();
    const env = { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key' };
    expect(JSON.parse(runCli(['datasource', 'show', 'qa-orders'], env).stdout).data.name).toBe('qa-orders');
    expect(() => JSON.parse(runCli(['learn', 'status'], env).stdout)).not.toThrow();
  });

  it('rejects the removed --json flag', () => {
    const out = runCli(['--json', 'datasource', 'list']);
    expect(out.status).not.toBe(0);
    expect(JSON.parse(out.stdout).error.code).toBe('CLI_ERROR');
  });

  it('names the replacement for a flag or command removed in 1.0', () => {
    expect(JSON.parse(runCli(['--json', 'datasource', 'list']).stdout).error.message).toMatch(/removed in 1\.0: output is always one line of compact JSON/);
    expect(JSON.parse(runCli(['daemon', 'start']).stdout).error.message).toMatch(/removed in 1\.0: the first taproot query starts the daemon/);
    expect(JSON.parse(runCli(['query', '--bogus']).stdout).error.message).toBe("error: unknown option '--bogus'");
  });

  it('rejects --sql and --query together', () => {
    const out = JSON.parse(runCli(['query', '--datasource', 'qa-orders', '--sql', 'SELECT 1', '--query', 'SELECT 2']).stdout);
    expect(out.error.code).toBe('BAD_INPUT');
  });

  it('prints exactly one JSON document and nothing on stderr for every CLI surface', () => {
    for (const args of [[], ['--version'], ['--help'], ['query', '--help'], ['daemon'], ['nosuch'], ['query', '--bogus'], ['--json', 'datasource', 'list']]) {
      const out = runCli(args);
      expect(out.stderr, args.join(' ')).toBe('');
      expect(out.stdout.trim().split('\n'), args.join(' ')).toHaveLength(1);
      expect(() => JSON.parse(out.stdout), args.join(' ')).not.toThrow();
    }
  });

  it('prints CLI errors as a JSON envelope', () => {
    const out = runCli(['query', '--bogus']);
    expect(out.status).not.toBe(0);
    expect(JSON.parse(out.stdout).error.code).toBe('CLI_ERROR');
  });

  it('redacts creds in JSON', () => {
    const stateRoot = setupStateRoot();
    const env = { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key' };
    expect(runCli(['creds', 'set', '--ref', 'qa:orders', '--user', 'qa_user', '--password', 'secret'], env).status).toBe(0);
    const parsed = JSON.parse(runCli(['creds', 'show', '--ref', 'qa:orders'], env).stdout).data;
    expect(parsed.values.user).toBe('qa_user');
    expect(parsed.values.password).toBe('[REDACTED]');
  });
});
