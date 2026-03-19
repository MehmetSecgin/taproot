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

function setupState() {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-policy-'));
  const configDir = path.join(stateRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'deterministic-config.json'),
    JSON.stringify({
      environmentPolicies: {
        careful: {
          deterministicRequired: true,
          allowDiscoveryByDefault: false,
          preferredAccessMethods: ['tsh'],
          targetPreference: ['tidb', 'mysql'],
        },
      },
      serviceAliases: {
        legacyservice: 'sample-service',
      },
    }),
  );
  const memoryRoot = path.join(stateRoot, 'memory-root');
  const kbDir = path.join(memoryRoot, 'domains', 'engineering', 'references', 'db-kb');
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(
    path.join(kbDir, 'services.json'),
    JSON.stringify([
      { service: 'orders', connections: [] },
      { service: 'sample-service', connections: [] },
    ]),
  );
  return {
    env: {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    },
  };
}

describe('runtime policy and explicit cache commands', () => {
  it('supports explicit target and query cache commands', () => {
    const { env } = setupState();
    const saveTarget = runCli(
      ['--json', 'cache', 'save-target', '--env', 'careful', '--service', 'orders', '--intent', 'latest rows', '--engine', 'tidb', '--target', 'tidb-careful-orders', '--database', 'orders'],
      env,
    );
    expect(saveTarget.status).toBe(0);
    expect(JSON.parse(saveTarget.stdout).target).toBe('tidb-careful-orders');

    const lookupTarget = runCli(
      ['--json', 'cache', 'lookup-target', '--env', 'careful', '--service', 'orders', '--intent', 'latest rows'],
      env,
    );
    expect(lookupTarget.status).toBe(0);
    expect(JSON.parse(lookupTarget.stdout).database).toBe('orders');

    const saveQuery = runCli(
      ['--json', 'cache', 'save-query', '--service', 'orders', '--intent', 'latest rows', '--sql-template', 'SELECT * FROM orders WHERE id = :id'],
      env,
    );
    expect(saveQuery.status).toBe(0);

    const resolveQuery = runCli(
      ['--json', 'cache', 'resolve-query', '--service', 'orders', '--intent', 'latest rows'],
      env,
    );
    expect(resolveQuery.status).toBe(0);
    expect(JSON.parse(resolveQuery.stdout).sqlTemplate).toContain(':id');
  });

  it('lists KB services', () => {
    const { env } = setupState();
    const out = runCli(['--json', 'kb', 'list-services'], env);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(['orders', 'sample-service']);
  });
});
