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

function setupKbState() {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-kb-'));
  const configDir = path.join(stateRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'deterministic-config.json'),
    JSON.stringify({
      serviceAliases: {
        legacy: 'orders',
      },
    }),
  );
  const memoryRoot = path.join(stateRoot, 'memory-root');
  const kbDir = path.join(memoryRoot, 'domains', 'engineering', 'references', 'db-kb');
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(
    path.join(kbDir, 'services.json'),
    JSON.stringify([
      {
        service: 'payments',
        connections: [
          {
            env: 'qa',
            engine: 'mysql',
            database: 'payments',
            access_method: 'native',
            status: 'active',
            verified_at_utc: '2026-03-01T00:00:00Z',
          },
        ],
      },
      {
        service: 'orders',
        connections: [
          {
            env: 'qa',
            engine: 'mysql',
            database: 'orders_old',
            db_user: 'orders_reader_old',
            access_method: 'native',
            status: 'active',
            verified_at_utc: '2026-03-01T00:00:00Z',
          },
          {
            env: 'qa',
            engine: 'mysql',
            database: 'orders',
            db_user: 'orders_reader',
            access_method: 'qa-portforward',
            target: 'orders-mysql',
            status: 'active',
            verified_at_utc: '2026-03-10T00:00:00Z',
          },
        ],
      },
      {
        service: 'orders',
        connections: [
          {
            env: 'prod',
            engine: 'mysql',
            database: 'orders_prod',
            access_method: 'native',
            status: 'active',
            verified_at_utc: '2026-03-11T00:00:00Z',
          },
        ],
      },
    ]),
  );
  fs.writeFileSync(
    path.join(kbDir, 'query-templates.json'),
    JSON.stringify([
      {
        id: 'contains-orders',
        service: 'orders',
        intent: 'orders',
        aliases: [],
        nativeQueryTemplate: 'SELECT * FROM orders LIMIT 10',
        status: 'active',
      },
      {
        id: 'latest-orders',
        service: 'orders',
        intent: 'latest orders',
        aliases: ['recent orders'],
        nativeQueryTemplate: 'SELECT * FROM orders ORDER BY created_at DESC LIMIT 10',
        status: 'active',
      },
    ]),
  );
  fs.writeFileSync(
    path.join(kbDir, 'table-catalog.json'),
    JSON.stringify([
      { service: 'orders', env: 'qa', database: 'orders', tables: ['orders', 'order_items'] },
      { service: 'payments', env: 'qa', database: 'payments', tables: ['payments'] },
    ]),
  );
  fs.writeFileSync(
    path.join(kbDir, 'relations.json'),
    JSON.stringify([
      {
        from: { service: 'orders', table: 'orders' },
        to: { service: 'payments', table: 'payments' },
        via: 'order_id',
      },
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

describe('kb resolution', () => {
  it('kb resolve-connection returns active connection', () => {
    const { env } = setupKbState();
    const out = runCli(['--json', 'kb', 'resolve-connection', '--service', 'orders', '--env', 'qa'], env);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ engine: 'mysql', database: 'orders', access_method: 'qa-portforward' });
  });

  it('kb resolve-connection prefers latest verified_at', () => {
    const { env } = setupKbState();
    const out = runCli(['--json', 'kb', 'resolve-connection', '--service', 'orders', '--env', 'qa'], env);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).verified_at_utc).toBe('2026-03-10T00:00:00Z');
  });

  it('kb resolve-credentials returns credential hints', () => {
    const { env } = setupKbState();
    const out = runCli(['--json', 'kb', 'resolve-credentials', '--service', 'orders', '--env', 'qa'], env);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).db_user).toBe('orders_reader');
  });

  it('kb resolve-database-name returns database', () => {
    const { env } = setupKbState();
    const out = runCli(['--json', 'kb', 'resolve-database-name', '--service', 'orders', '--env', 'qa'], env);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).database).toBe('orders');
  });

  it('kb resolve-query matches by intent', () => {
    const { env } = setupKbState();
    const out = runCli(['--json', 'kb', 'resolve-query', '--service', 'orders', '--intent', 'latest orders'], env);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).id).toBe('latest-orders');
  });

  it('kb resolve-query ranks exact > contains', () => {
    const { env } = setupKbState();
    const out = runCli(['--json', 'kb', 'resolve-query', '--service', 'orders', '--intent', 'latest orders'], env);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).nativeQueryTemplate).toContain('ORDER BY created_at DESC');
  });

  it('kb tables lists table catalog', () => {
    const { env } = setupKbState();
    const out = runCli(['--json', 'kb', 'tables', '--service', 'orders'], env);
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed[0].tables).toEqual(['orders', 'order_items']);
  });

  it('kb related shows relationships', () => {
    const { env } = setupKbState();
    const out = runCli(['--json', 'kb', 'related', '--service', 'orders'], env);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)[0]).toMatchObject({
      from: { service: 'orders', table: 'orders' },
      to: { service: 'payments', table: 'payments' },
    });
  });

  it('kb list-services returns unique sorted names', () => {
    const { env } = setupKbState();
    const out = runCli(['--json', 'kb', 'list-services'], env);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(['orders', 'payments']);
  });

  it('service alias resolves in kb commands', () => {
    const { env } = setupKbState();
    const out = runCli(['--json', 'kb', 'resolve-database-name', '--service', 'legacy', '--env', 'qa'], env);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ service: 'orders', database: 'orders' });
  });

  it('kb resolve-connection honors namespace when provided', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-kb-ns-'));
    const configDir = path.join(stateRoot, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'deterministic-config.json'), JSON.stringify({}));
    const memoryRoot = path.join(stateRoot, 'memory-root');
    const kbDir = path.join(memoryRoot, 'domains', 'engineering', 'references', 'db-kb');
    fs.mkdirSync(kbDir, { recursive: true });
    fs.writeFileSync(
      path.join(kbDir, 'services.json'),
      JSON.stringify([
        {
          service: 'orders',
          connections: [
            { env: 'qa', namespace: 'develop', engine: 'mysql', database: 'orders_dev', access_method: 'qa-portforward', status: 'active', verified_at_utc: '2026-03-01T00:00:00Z' },
            { env: 'qa', namespace: 'test', engine: 'mysql', database: 'orders_test', access_method: 'qa-portforward', status: 'active', verified_at_utc: '2026-03-02T00:00:00Z' },
          ],
        },
      ]),
    );
    const env = { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key', OBSIDIAN_MEMORY_ROOT: memoryRoot };
    const out = runCli(['--json', 'kb', 'resolve-connection', '--service', 'orders', '--env', 'qa', '--namespace', 'develop'], env);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ namespace: 'develop', database: 'orders_dev' });
  });
});
