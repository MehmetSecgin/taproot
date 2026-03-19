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

function setupState(input?: { runtimeConfig?: Record<string, unknown>; templates?: Array<Record<string, unknown>>; datasources?: Array<Record<string, unknown>> }) {
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
  return {
    env: {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_FORCE_DIRECT: '1',
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
});
