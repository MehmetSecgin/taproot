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
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-template-'));
  const configDir = path.join(stateRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');
  fs.writeFileSync(
    path.join(configDir, 'datasources.json'),
    JSON.stringify([
      {
        name: 'qa-orders',
        kind: 'mysql',
        env: 'qa',
        service: 'orders',
        tags: [],
        connection: { host: '127.0.0.1', port: 1, database: 'orders' },
        credentialRef: 'qa:orders',
        connectors: [],
        policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
        resolverHints: {},
        updatedAt: new Date().toISOString(),
        confidence: 0.9,
      },
    ]),
  );
  return {
    stateRoot,
    configDir,
    env: {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_FORCE_DIRECT: '1',
    },
  };
}

describe('template lifecycle', () => {
  it('template save creates a new template', () => {
    const { env } = setupState();
    const out = runCli(
      ['--json', 'template', 'save', '--id', 'orders.latest', '--intent', 'latest orders', '--query', 'SELECT * FROM orders ORDER BY created_at DESC LIMIT 10'],
      env,
    );
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).id).toBe('orders.latest');
  });

  it('template list includes saved template', () => {
    const { env } = setupState();
    runCli(['template', 'save', '--id', 'orders.latest', '--intent', 'latest orders', '--query', 'SELECT 1'], env);
    const out = runCli(['template', 'list'], env);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('orders.latest');
  });

  it('template validate passes for complete params', () => {
    const { env } = setupState();
    runCli(['template', 'save', '--id', 'orders.by-id', '--intent', 'order by id', '--query', 'SELECT * FROM orders WHERE id = :order_id'], env);
    const out = runCli(['--json', 'template', 'validate', '--id', 'orders.by-id'], env);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ valid: true, missingParams: [], extraPlaceholders: [] });
  });

  it('template validate fails for missing params', () => {
    const { env, configDir } = setupState();
    fs.writeFileSync(
      path.join(configDir, 'templates.json'),
      JSON.stringify([
        {
          id: 'orders.by-id',
          datasourceKind: 'mysql',
          intent: 'order by id',
          aliases: [],
          nativeQueryTemplate: 'SELECT * FROM orders WHERE id = :order_id',
          params: [],
          resultShape: 'table',
          tags: [],
          status: 'active',
          verifiedAt: new Date().toISOString(),
        },
      ]),
    );
    const out = runCli(['--json', 'template', 'validate', '--id', 'orders.by-id'], env);
    expect(out.status).toBe(2);
    expect(JSON.parse(out.stdout)).toMatchObject({ valid: false, extraPlaceholders: ['order_id'] });
  });

  it('template run renders params', () => {
    const { env } = setupState();
    runCli(['template', 'save', '--id', 'orders.by-id', '--intent', 'order by id', '--query', 'SELECT * FROM orders WHERE id = :order_id'], env);
    const out = runCli(['template', 'run', '--id', 'orders.by-id', '--param', 'order_id=42'], env);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('id = 42');
  });

  it('template run rejects unknown params', () => {
    const { env } = setupState();
    runCli(['template', 'save', '--id', 'orders.by-id', '--intent', 'order by id', '--query', 'SELECT * FROM orders WHERE id = :order_id'], env);
    const out = runCli(['template', 'run', '--id', 'orders.by-id', '--param', 'order_id=42', '--param', 'unknown=1'], env);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('Unknown --param');
  });

  it('template save with aliases enables intent resolution', () => {
    const { env } = setupState();
    runCli(
      ['template', 'save', '--id', 'orders.by-id', '--intent', 'latest orders', '--alias', 'recent orders', '--query', 'SELECT * FROM orders WHERE id = :order_id'],
      env,
    );
    const out = runCli(['query', '--datasource', 'qa-orders', '--intent', 'recent orders'], env);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('Missing --param for :order_id');
  });
});
