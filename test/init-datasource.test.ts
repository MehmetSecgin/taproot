import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { kubectlPortforwardLocalPort } from '../src/core/kubectl-portforward.js';
import {
  cliEnv,
  createEmptyKbDir,
  createOrdersKbDir,
  parseCredsShowOutput,
  parseInitDatasourceOutput,
  readSavedDatasources,
  writeServicesJson,
} from './helpers/init-fixtures.js';
import type { InitDatasourceResult } from './helpers/init-fixtures.js';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';

const LEGACY_SHARED_PORT = 4406;

function mysqlKbConnection(overrides: Record<string, unknown>): Record<string, unknown> {
  return {
    engine: 'mysql',
    db_user: 'reader',
    access_method: 'kubectl-portforward',
    status: 'active',
    verified_at_utc: '2026-03-01T00:00:00Z',
    ...overrides,
  };
}

function initDatasourceOverSavedOrdersProfile(savedPort: number): InitDatasourceResult {
  const { stateRoot, configDir } = tempStateRoot();
  const kbDir = createOrdersKbDir();
  fs.writeFileSync(
    path.join(configDir, 'datasources.json'),
    JSON.stringify([
      {
        name: 'qa-develop-orders',
        kind: 'mysql',
        env: 'qa',
        namespace: 'develop',
        service: 'orders',
        tags: ['auto-bootstrap'],
        connection: { host: '127.0.0.1', port: savedPort, database: 'orders' },
        credentialRef: 'qa:orders',
        connectors: ['kubectl-portforward'],
        policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
        resolverHints: {
          'kubectl-portforwardCredentialRef': 'kpf:qa:orders',
        },
        updatedAt: new Date().toISOString(),
      },
    ]),
  );
  const out = runCli(['init', 'datasource', '--env', 'qa', '--service', 'orders'], {
    ...cliEnv(stateRoot, kbDir),
    TAPROOT_NO_KEYCHAIN: '1',
  });
  expect(out.status).toBe(0);
  return parseInitDatasourceOutput(out.stdout).data;
}

function initProdDatasourceOverConflictingProfile(): { stateRoot: string; configDir: string; kbDir: string; result: InitDatasourceResult } {
  const { stateRoot, configDir } = tempStateRoot();
  const kbDir = writeServicesJson(createEmptyKbDir(), [
    {
      service: 'orders',
      connections: [mysqlKbConnection({ env: 'prod', database: 'orders', access_method: 'tsh', target: 'orders-tidb' })],
    },
  ]);
  fs.writeFileSync(
    path.join(configDir, 'datasources.json'),
    JSON.stringify([
      {
        name: 'prod-orders',
        kind: 'mysql',
        env: 'prod',
        service: 'orders',
        tags: [],
        connection: { host: '127.0.0.1', port: 3306, database: 'orders' },
        credentialRef: 'prod',
        connectors: [],
        policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
        resolverHints: {},
        updatedAt: new Date().toISOString(),
      },
    ]),
  );
  const env = cliEnv(stateRoot, kbDir);
  const seed = runCli(['creds', 'set', '--ref', 'prod', '--db-user', 'existing-reader'], env);
  expect(seed.status).toBe(0);
  const out = runCli(['init', 'datasource', '--env', 'prod', '--service', 'orders'], env);
  expect(out.status).toBe(0);
  return { stateRoot, configDir, kbDir, result: parseInitDatasourceOutput(out.stdout).data };
}

describe('init datasource command', () => {
  it('saves a profile for each KB connection', () => {
    // arrange
    const { stateRoot, configDir } = tempStateRoot();

    // act
    const out = runCli(['init', 'datasource', '--env', 'qa', '--service', 'orders'], cliEnv(stateRoot, createOrdersKbDir()));

    // assert
    expect(out.status).toBe(0);
    expect(parseInitDatasourceOutput(out.stdout).data.source).toBe('kb-bootstrap');
    const [saved] = readSavedDatasources(configDir);
    expect(saved.name).toBe('qa-develop-orders');
    expect(saved.namespace).toBe('develop');
  });

  it('keeps a profile that already exists instead of overwriting it', () => {
    // act
    const result = initDatasourceOverSavedOrdersProfile(kubectlPortforwardLocalPort('qa', 'develop', 'orders'));

    // assert
    expect(result.source).toBe('store-existing');
    expect(result).not.toHaveProperty('skipped');
    expect(result).not.toHaveProperty('connectors');
    expect(result).not.toHaveProperty('warnings');
  });

  it('rewrites a profile saved with the legacy shared kubectl-portforward port', () => {
    // act
    const result = initDatasourceOverSavedOrdersProfile(LEGACY_SHARED_PORT);

    // assert
    expect(result.source).toBe('kb-repaired');
    expect(result.profile.connection.port).toBe(kubectlPortforwardLocalPort('qa', 'develop', 'orders'));
  });

  it('creates namespace-aware datasource profile from KB when namespace is targeted explicitly', () => {
    // arrange
    const { stateRoot } = tempStateRoot();
    const kbDir = writeServicesJson(createEmptyKbDir(), [
      {
        service: 'orders',
        connections: [
          mysqlKbConnection({ env: 'qa', namespace: 'develop', database: 'orders_dev', target: 'orders-develop-db' }),
          mysqlKbConnection({ env: 'qa', namespace: 'test', database: 'orders_test', target: 'orders-test-db', verified_at_utc: '2026-03-02T00:00:00Z' }),
        ],
      },
    ]);

    // act
    const out = runCli(['init', 'datasource', '--env', 'qa', '--namespace', 'develop', '--service', 'orders'], cliEnv(stateRoot, kbDir));

    // assert
    expect(out.status).toBe(0);
    expect(parseInitDatasourceOutput(out.stdout).data.profile).toMatchObject({
      name: 'qa-develop-orders',
      env: 'qa',
      namespace: 'develop',
      service: 'orders',
      connection: { database: 'orders_dev' },
    });
  });

  it('repairs an existing profile that critically conflicts with the KB', () => {
    // act
    const { result } = initProdDatasourceOverConflictingProfile();

    // assert
    expect(result.source).toBe('kb-repaired');
    expect(result.profile.kind).toBe('teleport-mysql');
    expect(result.profile.connection.target).toBe('orders-tidb');
    expect(result.profile.credentialRef).toBe('prod');
  });

  it('replaces the conflicting profile on disk instead of adding a second one', () => {
    // act
    const { configDir } = initProdDatasourceOverConflictingProfile();

    // assert
    const saved = readSavedDatasources(configDir);
    expect(saved).toHaveLength(1);
    expect(saved[0].kind).toBe('teleport-mysql');
  });

  it('keeps the credentials stored under the repaired profile ref', () => {
    // arrange
    const { stateRoot, kbDir } = initProdDatasourceOverConflictingProfile();

    // act
    const creds = runCli(['creds', 'show', '--ref', 'prod'], cliEnv(stateRoot, kbDir));

    // assert
    expect(creds.status).toBe(0);
    expect(parseCredsShowOutput(creds.stdout).data.values.dbUser).toBe('existing-reader');
  });
});
