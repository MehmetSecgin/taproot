import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';

function setupState(input?: {
  runtimeConfig?: Record<string, unknown>;
  datasources?: Array<Record<string, unknown>>;
  kbServices?: Array<Record<string, unknown>>;
}) {
  const { stateRoot, configDir } = tempStateRoot();
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
  fs.writeFileSync(path.join(configDir, 'deterministic-config.json'), JSON.stringify(input?.runtimeConfig || {}));
  const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-query-resolution-kb-'));
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'services.json'), JSON.stringify(input?.kbServices || []));
  return {
    stateRoot,
    env: {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_FORCE_DIRECT: '1',
      TAPROOT_KB_DIR: kbDir,
    },
  };
}

describe('query resolution', () => {
  it('resolves explicit --datasource from store', () => {
    const { env } = setupState();
    const out = runCli(['query', '--datasource', 'qa-orders', '--sql', 'SELECT 1'], env);
    expect(out.status).toBe(3);
    expect(out.stdout).not.toContain('DETERMINISTIC_REQUIRED');
  });

  it('explicit --datasource with non-conventional name uses profile env/service for KB conflict checks', () => {
    // Profile name 'nudge-test' would naively parse as env='nudge' service='test'. The
    // profile's actual env is 'prod' / service 'orders'. KB has a conflicting prod/orders
    // entry. Conflict can only fire when env and service are taken from the profile, not
    // from the parsed name.
    const { env } = setupState({
      datasources: [
        {
          name: 'nudge-test',
          kind: 'mysql',
          env: 'prod',
          service: 'orders',
          tags: [],
          connection: { host: '127.0.0.1', port: 3306, database: 'orders', target: 'wrong-target' },
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
    const out = runCli(['query', '--datasource', 'nudge-test', '--sql', 'SELECT 1'], env);
    expect(out.stdout).toContain('MISCONFIGURED_DATASOURCE');
  });

  it('resolves --env + --service from store', () => {
    const { env } = setupState();
    const out = runCli(['query', '--env', 'qa', '--service', 'orders', '--sql', 'SELECT 1'], env);
    expect(out.status).toBe(3);
    expect(out.stdout).not.toContain('DETERMINISTIC_REQUIRED');
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
    const out = runCli(['query', '--env', 'prod', '--service', 'unknown', '--sql', 'SELECT 1'], env);
    expect(out.status).toBe(2);
    expect(out.stdout).toContain('DETERMINISTIC_REQUIRED');
    expect(out.stdout).toContain(`KB directory ${env.TAPROOT_KB_DIR} has no services in services.json`);
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
    const out = runCli(['query', '--env', 'prod', '--service', 'unknown', '--sql', 'SELECT 1', '--allow-discovery'], env);
    expect(out.status).toBe(2);
    expect(out.stdout).toContain('UNKNOWN_DATASOURCE');
    expect(out.stdout).not.toContain('DETERMINISTIC_REQUIRED');
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
      credentialRef: 'prod',
      connectors: ['teleport'],
      resolverHints: {
        teleportCredentialRef: 'tsh:prod',
      },
    });
  });

  it('allow-discovery without a KB row writes a port-forward profile for a Kubernetes target', () => {
    const { env, stateRoot } = setupState({
      datasources: [],
      runtimeConfig: { environmentPolicies: { qa: { preferredAccessMethods: ['tsh', 'qa-portforward'] } } },
    });
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-fake-kubectl-'));
    fs.writeFileSync(path.join(binDir, 'kubectl'), '#!/bin/sh\necho service/orders-mysql\n', { mode: 0o755 });
    runCli(['query', '--env', 'qa', '--service', 'orders', '--sql', 'SELECT 1', '--allow-discovery'], {
      ...env,
      PATH: binDir,
    });

    const datasources = JSON.parse(fs.readFileSync(path.join(stateRoot, 'config', 'datasources.json'), 'utf8'));
    expect(datasources).toHaveLength(1);
    expect(datasources[0]).toMatchObject({ kind: 'mysql', connectors: ['kubectl-portforward'] });
  });

  it('rejects the removed --reason and --allow-schema-introspection flags', () => {
    const { env } = setupState();
    for (const flag of [['--reason', 'why'], ['--allow-schema-introspection']]) {
      const out = runCli(['query', '--datasource', 'qa-orders', '--sql', 'SELECT 1', ...flag], env);
      expect(out.status).not.toBe(0);
      expect(JSON.parse(out.stdout).error.code).toBe('CLI_ERROR');
    }
  });

  it('malformed --param fails as bad input', () => {
    const { env } = setupState();
    const out = runCli(['query', '--datasource', 'qa-orders', '--sql', 'SELECT 1', '--param', 'brokenpair'], env);
    expect(out.status).toBe(2);
    expect(out.stdout).toContain("Invalid --param 'brokenpair'");
  });

  it('--explain without a query fails as bad input', () => {
    const { env } = setupState();
    const out = runCli(['query', '--datasource', 'qa-orders', '--explain'], env);
    expect(out.status).toBe(2);
    const envelope = JSON.parse(out.stdout);
    expect(envelope.error.code).toBe('BAD_INPUT');
    expect(envelope.error.message).toContain('--explain requires --sql');
  });

  it('service alias resolves transparently in query', () => {
    const { env } = setupState({
      runtimeConfig: {
        serviceAliases: {
          legacy: 'orders',
        },
      },
    });
    const out = runCli(['query', '--env', 'qa', '--service', 'legacy', '--sql', 'SELECT 1'], env);
    expect(out.status).toBe(3);
    expect(out.stdout).not.toContain('DETERMINISTIC_REQUIRED');
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
    const out = runCli(['query', '--env', 'prod', '--service', 'orders', '--sql', 'SELECT 1'], env);
    expect(out.status).toBe(2);
    expect(out.stdout).toContain('MISCONFIGURED_DATASOURCE');
  });
});
