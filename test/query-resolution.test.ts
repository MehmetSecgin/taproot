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

function setupState(input?: {
  runtimeConfig?: Record<string, unknown>;
  templates?: Array<Record<string, unknown>>;
  datasources?: Array<Record<string, unknown>>;
  kbServices?: Array<Record<string, unknown>>;
}) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-query-resolution-'));
  const configDir = path.join(stateRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'datasources.json'),
    JSON.stringify(
      input?.datasources || [
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
      ],
    ),
  );
  fs.writeFileSync(path.join(configDir, 'templates.json'), JSON.stringify(input?.templates || []));
  fs.writeFileSync(path.join(configDir, 'deterministic-config.json'), JSON.stringify(input?.runtimeConfig || {}));
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-query-resolution-memory-'));
  const kbDir = path.join(memoryRoot, 'domains', 'engineering', 'references', 'db-kb');
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'services.json'), JSON.stringify(input?.kbServices || []));
  return {
    stateRoot,
    env: {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_FORCE_DIRECT: '1',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    },
  };
}

describe('query resolution', () => {
  it('resolves explicit --datasource from store', () => {
    const { env } = setupState();
    const out = runCli(['query', '--datasource', 'qa-orders', '--query', 'SELECT 1'], env);
    expect(out.status).toBe(3);
    expect(out.stderr).not.toContain('DETERMINISTIC_REQUIRED');
  });

  it('resolves --env + --service from store', () => {
    const { env } = setupState();
    const out = runCli(['query', '--env', 'qa', '--service', 'orders', '--query', 'SELECT 1'], env);
    expect(out.status).toBe(3);
    expect(out.stderr).not.toContain('DETERMINISTIC_REQUIRED');
  });

  it('DETERMINISTIC_REQUIRED when env policy enforces it', () => {
    const { env } = setupState({
      datasources: [],
      runtimeConfig: {
        environmentPolicies: {
          prod: {
            deterministicRequired: true,
            allowDiscoveryByDefault: false,
          },
        },
      },
    });
    const out = runCli(['query', '--env', 'prod', '--service', 'unknown', '--query', 'SELECT 1'], env);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('DETERMINISTIC_REQUIRED');
  });

  it('--allow-discovery overrides deterministic requirement', () => {
    const { env } = setupState({
      datasources: [],
      runtimeConfig: {
        environmentPolicies: {
          prod: {
            deterministicRequired: true,
            allowDiscoveryByDefault: false,
          },
        },
      },
    });
    const out = runCli(['query', '--env', 'prod', '--service', 'unknown', '--query', 'SELECT 1', '--allow-discovery'], env);
    expect(out.status).toBe(1);
    expect(out.stderr).not.toContain('DETERMINISTIC_REQUIRED');
  });

  it('allow-discovery reuses canonical bootstrap shape for KB-backed discovery targets', () => {
    const { env, stateRoot } = setupState({
      datasources: [],
      kbServices: [
        {
          service: 'orders',
          connections: [
            {
              env: 'prod',
              engine: 'mysql',
              database: 'orders',
              db_user: 'reader',
              access_method: 'tsh',
              target: 'orders-tidb',
              status: 'active',
              verified_at_utc: '2026-03-01T00:00:00Z',
            },
          ],
        },
      ],
    });
    const out = runCli(['query', '--env', 'prod', '--service', 'orders', '--allow-discovery'], {
      ...env,
      PATH: '',
    });
    expect(out.status).not.toBe(0);

    const datasources = JSON.parse(fs.readFileSync(path.join(stateRoot, 'config', 'datasources.json'), 'utf8'));
    expect(datasources).toHaveLength(1);
    expect(datasources[0]).toMatchObject({
      name: 'prod-orders',
      kind: 'teleport-mysql',
      env: 'prod',
      service: 'orders',
      tags: ['auto-bootstrap', 'kb-derived'],
      connection: {
        database: 'orders',
        target: 'orders-tidb',
      },
      credentialRef: 'prod:orders',
      connectors: ['openvpn', 'teleport'],
      resolverHints: {
        openvpnCredentialRef: 'vpn:work',
        teleportCredentialRef: 'tsh:prod',
      },
    });
  });

  it('intent resolves from template store', () => {
    const { env } = setupState({
      templates: [
        {
          id: 'orders.by-id',
          datasourceName: 'qa-orders',
          datasourceKind: 'mysql',
          intent: 'latest orders',
          aliases: [],
          nativeQueryTemplate: 'SELECT * FROM orders WHERE id = :order_id',
          params: ['order_id'],
          resultShape: 'table',
          tags: [],
          status: 'active',
          verifiedAt: new Date().toISOString(),
        },
      ],
    });
    const out = runCli(['query', '--datasource', 'qa-orders', '--intent', 'latest orders'], env);
    expect(out.status).toBe(1);
    expect(out.stderr).toContain('Missing --param for :order_id');
  });

  it('service alias resolves transparently in query', () => {
    const { env } = setupState({
      runtimeConfig: {
        serviceAliases: {
          legacy: 'orders',
        },
      },
    });
    const out = runCli(['query', '--env', 'qa', '--service', 'legacy', '--query', 'SELECT 1'], env);
    expect(out.status).toBe(3);
    expect(out.stderr).not.toContain('DETERMINISTIC_REQUIRED');
  });

  it('fails with MISCONFIGURED_DATASOURCE when store conflicts with stronger KB routing', () => {
    const { env } = setupState({
      datasources: [
        {
          name: 'prod-orders',
          kind: 'mysql',
          env: 'prod',
          service: 'orders',
          tags: [],
          connection: { host: '127.0.0.1', port: 3306, database: 'orders' },
          credentialRef: 'prod:orders',
          connectors: [],
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          resolverHints: {},
          updatedAt: new Date().toISOString(),
          confidence: 0.9,
        },
      ],
      kbServices: [
        {
          service: 'orders',
          connections: [
            {
              env: 'prod',
              engine: 'mysql',
              database: 'orders',
              db_user: 'reader',
              access_method: 'tsh',
              target: 'orders-tidb',
              status: 'active',
              verified_at_utc: '2026-03-01T00:00:00Z',
            },
          ],
        },
      ],
    });
    const out = runCli(['query', '--env', 'prod', '--service', 'orders', '--query', 'SELECT 1'], env);
    expect(out.status).toBe(2);
    expect(out.stderr).toContain('MISCONFIGURED_DATASOURCE');
  });
});
