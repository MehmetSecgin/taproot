import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function runCli(args: string[], env: Record<string, string> = {}, input?: string) {
  const distCli = path.join(process.cwd(), 'dist', 'index.js');
  return spawnSync(process.execPath, [distCli, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
    input,
  });
}

function makeStateRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeMemoryRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setupKb(memoryRoot: string) {
  const kbDir = path.join(memoryRoot, 'domains', 'engineering', 'references', 'db-kb');
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(
    path.join(kbDir, 'services.json'),
    JSON.stringify([
      {
        service: 'orders',
        connections: [
          {
            env: 'qa',
            namespace: 'develop',
            engine: 'mysql',
            database: 'orders_dev',
            db_user: 'reader',
            access_method: 'qa-portforward',
            target: 'orders-db',
            status: 'active',
            verified_at_utc: '2026-03-01T00:00:00Z',
          },
        ],
      },
    ]),
  );
}

describe('onboard command', () => {
  it('prints an interactive closeout summary', () => {
    const stateRoot = makeStateRoot('taproot-onboard-state-');
    const memoryRoot = makeMemoryRoot('taproot-onboard-memory-');
    const out = runCli(['onboard'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    }, 'y\nn\nn\nn\n');
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('TapRoot onboarding');
    expect(out.stdout).toContain('Done');
    expect(out.stdout).toContain('Not done yet');
    expect(out.stdout).toContain('Skipped by choice');
    expect(out.stdout).toContain('Next commands');
    const configFile = path.join(stateRoot, 'config', 'deterministic-config.json');
    expect(fs.existsSync(configFile)).toBe(true);
  });

  it('creates a KB-backed datasource through json onboarding when approvals are supplied', () => {
    const stateRoot = makeStateRoot('taproot-onboard-json-state-');
    const memoryRoot = makeMemoryRoot('taproot-onboard-json-memory-');
    setupKb(memoryRoot);
    const out = runCli(
      ['--json', 'onboard', '--yes-local', '--yes-live', '--env', 'qa', '--namespace', 'develop', '--service', 'orders'],
      {
        TAPROOT_STATE_ROOT: stateRoot,
        TAPROOT_MASTER_KEY: 'test-key',
        OBSIDIAN_MEMORY_ROOT: memoryRoot,
      },
    );
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.datasource).toBe('qa-develop-orders');
    expect(parsed.steps.find((step: any) => step.id === 'datasource_setup')).toMatchObject({
      status: 'done',
    });
    const datasources = JSON.parse(fs.readFileSync(path.join(stateRoot, 'config', 'datasources.json'), 'utf8'));
    expect(datasources[0]).toMatchObject({
      name: 'qa-develop-orders',
      namespace: 'develop',
      service: 'orders',
    });
  });

  it('auto-creates starter config for regular commands before they fail for other reasons', () => {
    const stateRoot = makeStateRoot('taproot-onboard-query-state-');
    const out = runCli(
      ['query', '--env', 'prod', '--service', 'missing', '--query', 'SELECT 1 AS ok'],
      {
        TAPROOT_FORCE_DIRECT: '1',
        TAPROOT_STATE_ROOT: stateRoot,
      },
    );
    expect(out.status).not.toBe(0);
    const configFile = path.join(stateRoot, 'config', 'deterministic-config.json');
    expect(fs.existsSync(configFile)).toBe(true);
  });

  it('supports manual datasource creation during interactive onboarding when KB is missing', () => {
    const stateRoot = makeStateRoot('taproot-onboard-manual-state-');
    const memoryRoot = makeMemoryRoot('taproot-onboard-manual-memory-');
    const out = runCli(
      ['onboard'],
      {
        TAPROOT_STATE_ROOT: stateRoot,
        TAPROOT_MASTER_KEY: 'test-key',
        OBSIDIAN_MEMORY_ROOT: memoryRoot,
      },
      [
        'y', // local
        'n', // access
        'y', // target
        'qa', // env
        '', // namespace
        'manual-orders', // service
        'y', // live
        'y', // manual setup
        'native', // mode
        'mysql', // engine
        'orders', // database
        '127.0.0.1', // host
        '3306', // port
        'reader', // db user
        'n', // validation
        '',
      ].join('\n'),
    );
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('Datasource already existed: qa-manual-orders');
    const datasources = JSON.parse(fs.readFileSync(path.join(stateRoot, 'config', 'datasources.json'), 'utf8'));
    expect(datasources[0]).toMatchObject({
      name: 'qa-manual-orders',
      kind: 'mysql',
      env: 'qa',
      service: 'manual-orders',
      connection: {
        host: '127.0.0.1',
        port: 3306,
        database: 'orders',
      },
    });
  });

  it('validates saved manual datasources without collapsing to missing_kb', () => {
    const stateRoot = makeStateRoot('taproot-onboard-manual-validate-state-');
    const memoryRoot = makeMemoryRoot('taproot-onboard-manual-validate-memory-');
    const out = runCli(
      ['onboard'],
      {
        TAPROOT_STATE_ROOT: stateRoot,
        TAPROOT_MASTER_KEY: 'test-key',
        OBSIDIAN_MEMORY_ROOT: memoryRoot,
      },
      [
        'y', // local
        'n', // access
        'y', // target
        'qa',
        'develop',
        'sample-service',
        'y', // live
        'y', // manual setup
        'qa-portforward',
        'mysql',
        'sample_db',
        'sample-service',
        '4406',
        'root',
        'y', // validation
        '',
      ].join('\n'),
    );
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('Target-specific readiness is incomplete because connector checks are still blocked.');
    expect(out.stdout).not.toContain('missing_kb');
    expect(out.stdout).not.toContain('taproot --json init');
    expect(out.stdout).toContain('taproot doctor --datasource qa-develop-sample-service --connect');
  });

  it('treats declined manual datasource setup as skipped instead of generic missing-kb validation', () => {
    const stateRoot = makeStateRoot('taproot-onboard-decline-state-');
    const memoryRoot = makeMemoryRoot('taproot-onboard-decline-memory-');
    const out = runCli(
      ['onboard'],
      {
        TAPROOT_STATE_ROOT: stateRoot,
        TAPROOT_MASTER_KEY: 'test-key',
        OBSIDIAN_MEMORY_ROOT: memoryRoot,
      },
      [
        'y', // local
        'y', // access
        'y', // target
        'sandbox',
        'preview',
        'sample-service',
        'y', // live
        'n', // manual setup
        'y', // validation
        '',
      ].join('\n'),
    );
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('Skipped manual datasource setup after KB was not found.');
    expect(out.stdout).toContain('Skipped final validation because no datasource was created.');
    expect(out.stdout).not.toContain('missing_kb');
    expect(out.stdout).not.toContain('taproot --json init');
  });
});
