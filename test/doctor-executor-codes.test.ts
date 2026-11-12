import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';

describe('doctor executor codes', () => {
  it('returns executor_connectivity for mysql doctor connection failures', () => {
    const { stateRoot, configDir } = tempStateRoot();
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

    const out = runCli(['doctor', '--datasource', 'qa-demo'], env);
    expect(out.status).toBe(3);
    const parsed = JSON.parse(out.stdout).data;
    expect(parsed.checks.find((check: { check: string }) => check.check === 'mysql connect')?.code).toBe('executor_connectivity');
  });

  it('returns executor_missing_tool when tsh is not on PATH', () => {
    const { stateRoot, configDir } = tempStateRoot();
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

    const out = runCli(['doctor', '--datasource', 'prod-orders'], env);
    expect(out.status).toBe(7);
    const parsed = JSON.parse(out.stdout).data;
    expect(parsed.checks.find((check: { check: string }) => check.check === 'teleport-mysql query')?.code).toBe(
      'executor_missing_tool',
    );
  });

  it('returns executor_configuration_missing when the profile has no connection', () => {
    const { stateRoot, configDir } = tempStateRoot();
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

    const out = runCli(['doctor', '--datasource', 'prod-orders'], env);
    expect(out.status).toBe(1);
    const parsed = JSON.parse(out.stdout).data;
    expect(parsed.checks.find((check: { check: string }) => check.check === 'teleport-mysql doctor')?.code).toBe(
      'executor_configuration_missing',
    );
  });
});
