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

describe('doctor executor codes', () => {
  it('returns executor_connectivity for mysql doctor connection failures', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-doctor-executor-mysql-'));
    const configDir = path.join(stateRoot, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'datasources.json'),
      JSON.stringify([
        {
          name: 'qa-demo',
          kind: 'mysql',
          env: 'qa',
          service: 'demo',
          tags: [],
          connection: { host: '127.0.0.1', port: 1, database: 'demo' },
          credentialRef: 'qa:demo',
          connectors: [],
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          resolverHints: {},
          updatedAt: new Date().toISOString(),
          confidence: 0.9,
        },
      ]),
    );
    fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');

    const env = {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
    };
    const seed = runCli(['creds', 'set', '--ref', 'qa:demo', '--user', 'reader', '--password', 'bad'], env);
    expect(seed.status).toBe(0);

    const out = runCli(['--json', 'doctor', '--datasource', 'qa-demo'], env);
    expect(out.status).toBe(3);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.checks.find((check: { check: string }) => check.check === 'mysql connect')?.code).toBe('executor_connectivity');
    expect(parsed.nextActionDetails[0].command).toBe('taproot datasource show --name qa-demo');
    expect(parsed.nextActionDetails[0]).toMatchObject({
      command: 'taproot datasource show --name qa-demo',
      priority: 60,
      checks: ['mysql connect'],
      codes: ['executor_connectivity'],
    });
    expect(parsed.nextActionDetails[0].reasons[0]).toContain('Executor connectivity failed');
  });

  it('returns executor_connectivity for teleport-mysql proxy bootstrap failures', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-doctor-executor-teleport-'));
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
          resolverHints: {},
          updatedAt: new Date().toISOString(),
          confidence: 0.9,
        },
      ]),
    );
    fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');

    const env = {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      PATH: '',
    };
    const seed = runCli(['creds', 'set', '--ref', 'prod:orders', '--db-user', 'reader'], env);
    expect(seed.status).toBe(0);

    const out = runCli(['--json', 'doctor', '--datasource', 'prod-orders'], env);
    expect(out.status).toBe(3);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.checks.find((check: { check: string }) => check.check === 'teleport-mysql query')?.code).toBe(
      'executor_connectivity',
    );
    expect(parsed.nextActionDetails[0].command).toBe('taproot datasource show --name prod-orders');
    expect(parsed.nextActionDetails[0].command).toBe('taproot datasource show --name prod-orders');
  });

  it('returns repair hints for executor configuration failures', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-doctor-executor-config-'));
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
          connection: {},
          credentialRef: 'prod:orders',
          connectors: [],
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          resolverHints: {},
          updatedAt: new Date().toISOString(),
          confidence: 0.9,
        },
      ]),
    );
    fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');

    const env = {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
    };

    const out = runCli(['--json', 'doctor', '--datasource', 'prod-orders'], env);
    expect(out.status).toBe(1);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.checks.find((check: { check: string }) => check.check === 'teleport-mysql doctor')?.code).toBe(
      'executor_configuration_missing',
    );
    expect(parsed.nextActionDetails[0].command).toBe('taproot --json init datasource --env prod --service orders');
    expect(parsed.nextActionDetails[1].command).toBe('taproot --json creds set --ref prod:orders --db-user <user> --password <password>');
    expect(parsed.nextActionDetails[0]).toMatchObject({
      command: 'taproot --json init datasource --env prod --service orders',
      priority: 20,
      codes: ['executor_configuration_missing'],
    });
  });

  it('prioritizes connector reconnect before datasource inspection for stacked connectivity issues', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-doctor-executor-stacked-'));
    const configDir = path.join(stateRoot, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'datasources.json'),
      JSON.stringify([
        {
          name: 'qa-demo',
          kind: 'mysql',
          env: 'qa',
          service: 'demo',
          tags: [],
          connection: { host: '127.0.0.1', port: 1, database: 'demo' },
          credentialRef: 'qa:demo',
          connectors: ['openvpn'],
          resolverHints: { openvpnCredentialRef: 'vpn:work' },
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          updatedAt: new Date().toISOString(),
          confidence: 0.9,
        },
      ]),
    );
    fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');

    const env = {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
    };
    expect(runCli(['creds', 'set', '--ref', 'qa:demo', '--user', 'reader', '--password', 'bad'], env).status).toBe(0);
    expect(runCli(['creds', 'set', '--ref', 'vpn:work', '--status-command', 'false'], env).status).toBe(0);

    const out = runCli(['--json', 'doctor', '--datasource', 'qa-demo'], env);
    expect(out.status).toBe(3);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.nextActionDetails[0].command).toBe('taproot doctor --datasource qa-demo --connect');
    expect(parsed.nextActionDetails.map((d: { command: string }) => d.command)).toContain('taproot datasource show --name qa-demo');
    expect(parsed.nextActionDetails[0]).toMatchObject({
      command: 'taproot doctor --datasource qa-demo --connect',
      priority: 30,
    });
    expect(parsed.nextActionDetails[1].command).toBe('taproot datasource show --name qa-demo');
  });
});
