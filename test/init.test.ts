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

function makeStateRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-init-state-'));
}

function makeKbDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-init-kb-'));
}

function setupKb(kbDir: string, service = 'orders', env = 'qa') {
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(
    path.join(kbDir, 'services.json'),
    JSON.stringify([
      {
        service,
        connections: [
          {
            env,
            engine: 'mysql',
            database: 'orders',
            db_user: 'reader',
            access_method: 'qa-portforward',
            namespace: 'develop',
            target: 'orders-db',
            status: 'active',
            verified_at_utc: '2026-03-01T00:00:00Z',
          },
        ],
      },
    ]),
  );
  return kbDir;
}

function setupCustomKb(kbDir: string, services: Array<Record<string, unknown>>) {
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'services.json'), JSON.stringify(services));
  return kbDir;
}

describe('init command', () => {
  it('creates starter config with environmentPolicies and serviceAliases', () => {
    const stateRoot = makeStateRoot();
    const kbDir = makeKbDir();
    setupKb(kbDir);
    const out = runCli(['init'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_KB_DIR: kbDir,
    });
    expect(out.status).toBe(0);
    const configFile = path.join(stateRoot, 'config', 'deterministic-config.json');
    expect(fs.existsSync(configFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).toEqual({
      environmentPolicies: {},
      serviceAliases: {},
      kbDir,
    });
  });

  it('saves --kb-dir so later commands find the KB without TAPROOT_KB_DIR', () => {
    // arrange
    const stateRoot = makeStateRoot();
    const kbDir = makeKbDir();
    setupKb(kbDir);
    const env = { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key', TAPROOT_KB_DIR: '' };

    // act
    const init = runCli(['init', '--kb-dir', kbDir], env);
    const list = runCli(['kb', 'list-services'], env);

    // assert
    expect(init.status).toBe(0);
    expect(JSON.parse(init.stdout).data.savedKbDir).toBe(kbDir);
    expect(list.status).toBe(0);
    expect(JSON.parse(list.stdout).data).toEqual(['orders']);
  });

  it('keeps a saved kbDir when TAPROOT_KB_DIR points elsewhere', () => {
    // arrange
    const stateRoot = makeStateRoot();
    const savedKbDir = makeKbDir();
    setupKb(savedKbDir);
    runCli(['init', '--kb-dir', savedKbDir], { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key', TAPROOT_KB_DIR: '' });

    // act
    const out = runCli(['init'], { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key', TAPROOT_KB_DIR: makeKbDir() });

    // assert
    expect(out.status).toBe(0);
    const configFile = path.join(stateRoot, 'config', 'deterministic-config.json');
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8')).kbDir).toBe(savedKbDir);
  });

  it('fails KB commands with KB_MISSING naming the directory when no KB is set up', () => {
    // arrange
    const stateRoot = makeStateRoot();
    const env = { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key', TAPROOT_KB_DIR: '' };
    const expectedDir = path.join(stateRoot, 'kb');

    // act
    const resolve = runCli(['kb', 'resolve', '--env', 'qa', '--service', 'orders'], env);
    const initDatasource = runCli(['init', 'datasource', '--env', 'qa', '--service', 'orders'], env);

    // assert
    for (const out of [resolve, initDatasource]) {
      expect(out.status).toBe(7);
      const error = JSON.parse(out.stdout).error;
      expect(error.code).toBe('KB_MISSING');
      expect(error.message).toContain(`KB directory ${expectedDir} does not exist`);
      expect(error.message).toContain('taproot init --kb-dir <dir>');
    }
  });

  it('is idempotent when run twice', () => {
    const stateRoot = makeStateRoot();
    const kbDir = makeKbDir();
    setupKb(kbDir);
    const env = {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_KB_DIR: kbDir,
    };
    const first = runCli(['init'], env);
    expect(first.status).toBe(0);
    const configFile = path.join(stateRoot, 'config', 'deterministic-config.json');
    const before = fs.readFileSync(configFile, 'utf8');
    const second = runCli(['init'], env);
    expect(second.status).toBe(0);
    expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
  });

  it('reports missing KB deterministically', () => {
    const stateRoot = makeStateRoot();
    const kbDir = makeKbDir();
    const out = runCli(['init'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_KB_DIR: kbDir,
    });
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout).data;
    const kbCheck = parsed.checks.find((check: any) => check.check === 'kb_dir');
    expect(kbCheck.status).not.toBe('ok');
    expect(parsed.readiness).toBe('missing_kb');
  });

  it('reports credentials as optional when only redis datasources are configured', () => {
    // arrange
    const stateRoot = makeStateRoot();
    const kbDir = makeKbDir();
    setupKb(kbDir);
    const env = {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_KB_DIR: kbDir,
    };
    runCli(['init'], env);
    const added = runCli(
      ['datasource', 'add', '--name', 'cache', '--kind', 'redis', '--env', 'qa', '--service', 'cache', '--host', '127.0.0.1', '--port', '6379', '--credential-ref', 'qa:redis:cache'],
      env,
    );
    expect(added.status).toBe(0);

    // act
    const out = runCli(['init'], env);

    // assert
    expect(out.status).toBe(0);
    const credentials = JSON.parse(out.stdout).data.checks.find((c: { check: string }) => c.check === 'credentials');
    expect(credentials.status).toBe('ok');
  });

  it('does not ask for credentials when every datasource kind is auth-free', () => {
    // arrange
    const stateRoot = makeStateRoot();
    const kbDir = makeKbDir();
    setupKb(kbDir);
    const env = {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_KB_DIR: kbDir,
    };
    runCli(['init'], env);
    const added = runCli(
      ['datasource', 'add', '--name', 'pilot', '--kind', 'grpc', '--env', 'qa', '--service', 'profile', '--host', '127.0.0.1', '--port', '6565', '--credential-ref', 'pilot'],
      env,
    );
    expect(added.status).toBe(0);

    // act
    const out = runCli(['init'], env);

    // assert
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout).data;
    const credentials = parsed.checks.find((check: any) => check.check === 'credentials');
    expect(credentials.status).toBe('ok');
  });

  it('treats a missing master key as optional', () => {
    const stateRoot = makeStateRoot();
    const kbDir = makeKbDir();
    setupKb(kbDir);
    const out = runCli(['init'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_KB_DIR: kbDir,
    });
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout).data;
    const masterKeyCheck = parsed.checks.find((check: any) => check.check === 'master_key');
    expect(masterKeyCheck.status).toBe('ok');
  });

  it('returns machine-readable init summary', () => {
    const stateRoot = makeStateRoot();
    const kbDir = makeKbDir();
    setupKb(kbDir);
    const out = runCli(['init'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_KB_DIR: kbDir,
    });
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout).data;
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(typeof parsed.readiness).toBe('string');
  });

  it('creates datasource profile from KB', () => {
    const stateRoot = makeStateRoot();
    const kbDir = makeKbDir();
    setupKb(kbDir);
    const out = runCli(['init', 'datasource', '--env', 'qa', '--service', 'orders'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_KB_DIR: kbDir,
    });
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout).data;
    expect(parsed.source).toBe('kb-bootstrap');
    const datasources = JSON.parse(fs.readFileSync(path.join(stateRoot, 'config', 'datasources.json'), 'utf8'));
    expect(datasources[0].name).toBe('qa-develop-orders');
    expect(datasources[0].namespace).toBe('develop');
  });

  it('skips existing datasource profile', () => {
    const stateRoot = makeStateRoot();
    const kbDir = makeKbDir();
    setupKb(kbDir);
    const configDir = path.join(stateRoot, 'config');
    fs.mkdirSync(configDir, { recursive: true });
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
          connection: { host: '127.0.0.1', port: 4406, database: 'orders' },
          credentialRef: 'qa:orders',
          connectors: ['kubectl-portforward'],
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          resolverHints: {
            'kubectl-portforwardCredentialRef': 'kpf:qa:orders',
          },
          updatedAt: new Date().toISOString(),
          confidence: 0.9,
        },
      ]),
    );
    const out = runCli(['init', 'datasource', '--env', 'qa', '--service', 'orders'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_KB_DIR: kbDir,
    });
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout).data;
    expect(parsed.source).toBe('store-existing');
    expect(parsed.skipped).toBe(true);
  });

  it('creates namespace-aware datasource profile from KB when namespace is targeted explicitly', () => {
    const stateRoot = makeStateRoot();
    const kbDir = makeKbDir();
    setupCustomKb(kbDir, [
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
            target: 'orders-develop-db',
            status: 'active',
            verified_at_utc: '2026-03-01T00:00:00Z',
          },
          {
            env: 'qa',
            namespace: 'test',
            engine: 'mysql',
            database: 'orders_test',
            db_user: 'reader',
            access_method: 'qa-portforward',
            target: 'orders-test-db',
            status: 'active',
            verified_at_utc: '2026-03-02T00:00:00Z',
          },
        ],
      },
    ]);
    const out = runCli(['init', 'datasource', '--env', 'qa', '--namespace', 'develop', '--service', 'orders'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_KB_DIR: kbDir,
    });
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout).data;
    expect(parsed.profile).toMatchObject({
      name: 'qa-develop-orders',
      env: 'qa',
      namespace: 'develop',
      service: 'orders',
      connection: { database: 'orders_dev' },
    });
  });

  it('repairs existing datasource profile when it critically conflicts with KB', () => {
    const stateRoot = makeStateRoot();
    const kbDir = makeKbDir();
    setupCustomKb(kbDir, [
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
    ]);
    const configDir = path.join(stateRoot, 'config');
    fs.mkdirSync(configDir, { recursive: true });
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
          confidence: 0.4,
        },
      ]),
    );
    const seed = runCli(['creds', 'set', '--ref', 'prod', '--db-user', 'existing-reader'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_KB_DIR: kbDir,
    });
    expect(seed.status).toBe(0);

    const out = runCli(['init', 'datasource', '--env', 'prod', '--service', 'orders'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_KB_DIR: kbDir,
    });
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout).data;
    expect(parsed.source).toBe('kb-repaired');
    expect(parsed.skipped).toBe(false);
    expect(parsed.profile.kind).toBe('teleport-mysql');
    expect(parsed.profile.connection.target).toBe('orders-tidb');
    expect(parsed.profile.credentialRef).toBe('prod');

    const datasources = JSON.parse(fs.readFileSync(path.join(configDir, 'datasources.json'), 'utf8'));
    expect(datasources).toHaveLength(1);
    expect(datasources[0].kind).toBe('teleport-mysql');

    const creds = runCli(['creds', 'show', '--ref', 'prod'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_KB_DIR: kbDir,
    });
    expect(creds.status).toBe(0);
    const credsParsed = JSON.parse(creds.stdout).data;
    expect(credsParsed.values.dbUser).toBe('existing-reader');
  });
});
