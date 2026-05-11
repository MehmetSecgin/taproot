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

function makeMemoryRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-init-memory-'));
}

function setupKb(memoryRoot: string, service = 'orders', env = 'qa') {
  const kbDir = path.join(memoryRoot, 'domains', 'engineering', 'references', 'db-kb');
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

function setupCustomKb(memoryRoot: string, services: Array<Record<string, unknown>>) {
  const kbDir = path.join(memoryRoot, 'domains', 'engineering', 'references', 'db-kb');
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'services.json'), JSON.stringify(services));
  return kbDir;
}

describe('init command', () => {
  it('creates starter config with environmentPolicies and serviceAliases', () => {
    const stateRoot = makeStateRoot();
    const memoryRoot = makeMemoryRoot();
    setupKb(memoryRoot);
    const out = runCli(['--json', 'init'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    });
    expect(out.status).toBe(0);
    const configFile = path.join(stateRoot, 'config', 'deterministic-config.json');
    expect(fs.existsSync(configFile)).toBe(true);
    expect(JSON.parse(fs.readFileSync(configFile, 'utf8'))).toEqual({
      environmentPolicies: {},
      serviceAliases: {},
    });
  });

  it('is idempotent when run twice', () => {
    const stateRoot = makeStateRoot();
    const memoryRoot = makeMemoryRoot();
    setupKb(memoryRoot);
    const env = {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    };
    const first = runCli(['--json', 'init'], env);
    expect(first.status).toBe(0);
    const configFile = path.join(stateRoot, 'config', 'deterministic-config.json');
    const before = fs.readFileSync(configFile, 'utf8');
    const second = runCli(['--json', 'init'], env);
    expect(second.status).toBe(0);
    expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
  });

  it('reports missing KB deterministically', () => {
    const stateRoot = makeStateRoot();
    const memoryRoot = makeMemoryRoot();
    const out = runCli(['--json', 'init'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    });
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout);
    const kbCheck = parsed.checks.find((check: any) => check.check === 'kb_dir');
    expect(kbCheck.status).not.toBe('ok');
    expect(parsed.readiness).toBe('missing_kb');
  });

  it('warns when master key is missing', () => {
    const stateRoot = makeStateRoot();
    const memoryRoot = makeMemoryRoot();
    setupKb(memoryRoot);
    const out = runCli(['--json', 'init'], {
      TAPROOT_STATE_ROOT: stateRoot,
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    });
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout);
    const masterKeyCheck = parsed.checks.find((check: any) => check.check === 'master_key');
    expect(masterKeyCheck.status).toBe('warn');
  });

  it('returns machine-readable init summary', () => {
    const stateRoot = makeStateRoot();
    const memoryRoot = makeMemoryRoot();
    setupKb(memoryRoot);
    const out = runCli(['--json', 'init'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    });
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(Array.isArray(parsed.checks)).toBe(true);
    expect(typeof parsed.readiness).toBe('string');
    expect(Array.isArray(parsed.nextActionDetails)).toBe(true);
    expect(parsed.nextActionDetails[0]).toMatchObject({
      command: expect.any(String),
      priority: expect.any(Number),
      reasons: expect.any(Array),
      checks: expect.any(Array),
      codes: expect.any(Array),
    });
  });

  it('creates datasource profile from KB', () => {
    const stateRoot = makeStateRoot();
    const memoryRoot = makeMemoryRoot();
    setupKb(memoryRoot);
    const out = runCli(['--json', 'init', 'datasource', '--env', 'qa', '--service', 'orders'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    });
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.source).toBe('kb-bootstrap');
    const datasources = JSON.parse(fs.readFileSync(path.join(stateRoot, 'config', 'datasources.json'), 'utf8'));
    expect(datasources[0].name).toBe('qa-develop-orders');
    expect(datasources[0].namespace).toBe('develop');
  });

  it('skips existing datasource profile', () => {
    const stateRoot = makeStateRoot();
    const memoryRoot = makeMemoryRoot();
    setupKb(memoryRoot);
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
          connectors: ['openvpn', 'kubectl-portforward'],
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          resolverHints: {
            openvpnCredentialRef: 'vpn:work',
            'kubectl-portforwardCredentialRef': 'kpf:qa:orders',
          },
          updatedAt: new Date().toISOString(),
          confidence: 0.9,
        },
      ]),
    );
    const out = runCli(['--json', 'init', 'datasource', '--env', 'qa', '--service', 'orders'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    });
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.source).toBe('store-existing');
    expect(parsed.skipped).toBe(true);
  });

  it('creates namespace-aware datasource profile from KB when namespace is targeted explicitly', () => {
    const stateRoot = makeStateRoot();
    const memoryRoot = makeMemoryRoot();
    setupCustomKb(memoryRoot, [
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
    const out = runCli(['--json', 'init', 'datasource', '--env', 'qa', '--namespace', 'develop', '--service', 'orders'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    });
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout);
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
    const memoryRoot = makeMemoryRoot();
    setupCustomKb(memoryRoot, [
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
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    });
    expect(seed.status).toBe(0);

    const out = runCli(['--json', 'init', 'datasource', '--env', 'prod', '--service', 'orders'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    });
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.source).toBe('kb-repaired');
    expect(parsed.skipped).toBe(false);
    expect(parsed.profile.kind).toBe('teleport-mysql');
    expect(parsed.profile.connection.target).toBe('orders-tidb');
    expect(parsed.profile.credentialRef).toBe('prod');

    const datasources = JSON.parse(fs.readFileSync(path.join(configDir, 'datasources.json'), 'utf8'));
    expect(datasources).toHaveLength(1);
    expect(datasources[0].kind).toBe('teleport-mysql');

    const creds = runCli(['--json', 'creds', 'show', '--ref', 'prod'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    });
    expect(creds.status).toBe(0);
    const credsParsed = JSON.parse(creds.stdout);
    expect(credsParsed.values.dbUser).toBe('existing-reader');
  });

  it('returns readiness payload for self-check --agent', () => {
    const stateRoot = makeStateRoot();
    const memoryRoot = makeMemoryRoot();
    const configDir = path.join(stateRoot, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'deterministic-config.json'), JSON.stringify({ environmentPolicies: {}, serviceAliases: {} }));
    fs.writeFileSync(
      path.join(configDir, 'datasources.json'),
      JSON.stringify([
        {
          name: 'qa-orders',
          kind: 'mysql',
          env: 'qa',
          service: 'orders',
          tags: [],
          connection: { host: '127.0.0.1', port: 4406, database: 'orders' },
          credentialRef: 'qa:orders',
          connectors: [],
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          updatedAt: new Date().toISOString(),
          confidence: 0.9,
        },
      ]),
    );
    fs.writeFileSync(path.join(configDir, 'credentials.json.enc'), JSON.stringify({ bad: 'shape' }));
    setupKb(memoryRoot);
    const out = runCli(['--json', 'self-check', '--agent'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    });
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(typeof parsed.readiness).toBe('string');
    expect(parsed).toHaveProperty('missing');
    expect(parsed).toHaveProperty('nextCommand');
    expect(Array.isArray(parsed.nextActionDetails)).toBe(true);
  });

  it('returns missing_connector_config for targeted self-check when connector wiring is incomplete', () => {
    const stateRoot = makeStateRoot();
    const memoryRoot = makeMemoryRoot();
    const configDir = path.join(stateRoot, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'deterministic-config.json'), JSON.stringify({ environmentPolicies: {}, serviceAliases: {} }));
    fs.writeFileSync(
      path.join(configDir, 'datasources.json'),
      JSON.stringify([
        {
          name: 'qa-orders',
          kind: 'mysql',
          env: 'qa',
          service: 'orders',
          tags: [],
          connection: { host: '127.0.0.1', port: 4406, database: 'orders' },
          credentialRef: 'qa:orders',
          connectors: ['kubectl-portforward'],
          resolverHints: {},
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          updatedAt: new Date().toISOString(),
          confidence: 0.9,
        },
      ]),
    );
    setupKb(memoryRoot);
    const seed = runCli(['creds', 'set', '--ref', 'qa:orders', '--user', 'reader'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    });
    expect(seed.status).toBe(0);

    const out = runCli(['--json', 'self-check', '--agent', '--datasource', 'qa-orders'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    });
    expect(out.status).toBe(7);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.readiness).toBe('missing_connector_config');
    expect(parsed.target.datasource).toBe('qa-orders');
    expect(parsed.checks.find((check: { check: string }) => check.check === 'kubectl-portforward status')?.code).toBe(
      'connector_status_command_missing',
    );
    expect(parsed.nextActionDetails[0]).toMatchObject({
      command: expect.stringContaining('taproot connector setup --datasource qa-orders --connector kubectl-portforward'),
      priority: 50,
      checks: ['kubectl-portforward status'],
      codes: ['connector_status_command_missing'],
    });
    expect(parsed.nextCommand).toContain('taproot connector setup --datasource qa-orders --connector kubectl-portforward');
  });

  it('returns blocked_connector_auth for targeted self-check when connector status fails', () => {
    const stateRoot = makeStateRoot();
    const memoryRoot = makeMemoryRoot();
    const configDir = path.join(stateRoot, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'deterministic-config.json'), JSON.stringify({ environmentPolicies: {}, serviceAliases: {} }));
    fs.writeFileSync(
      path.join(configDir, 'datasources.json'),
      JSON.stringify([
        {
          name: 'qa-orders',
          kind: 'mysql',
          env: 'qa',
          service: 'orders',
          tags: [],
          connection: { host: '127.0.0.1', port: 4406, database: 'orders' },
          credentialRef: 'qa:orders',
          connectors: ['openvpn'],
          resolverHints: { openvpnCredentialRef: 'vpn:work' },
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          updatedAt: new Date().toISOString(),
          confidence: 0.9,
        },
      ]),
    );
    setupKb(memoryRoot);
    const seedDatasource = runCli(['creds', 'set', '--ref', 'qa:orders', '--user', 'reader'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    });
    expect(seedDatasource.status).toBe(0);
    const seedConnector = runCli(['creds', 'set', '--ref', 'vpn:work', '--status-command', 'false'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    });
    expect(seedConnector.status).toBe(0);

    const out = runCli(['--json', 'self-check', '--agent', '--datasource', 'qa-orders'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    });
    expect(out.status).toBe(7);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.readiness).toBe('blocked_connector_auth');
    expect(parsed.checks.find((check: { check: string }) => check.check === 'openvpn status')?.code).toBe('connector_status_blocked');
    expect(parsed.nextActionDetails[0]).toMatchObject({
      command: 'taproot doctor --datasource qa-orders --connect',
      priority: 60,
      checks: expect.arrayContaining(['openvpn status']),
      codes: expect.arrayContaining(['connector_status_blocked']),
    });
    expect(parsed.nextCommand).toBe('taproot doctor --datasource qa-orders --connect');
  });

  it('returns ready for targeted self-check when connector status succeeds', () => {
    const stateRoot = makeStateRoot();
    const memoryRoot = makeMemoryRoot();
    const configDir = path.join(stateRoot, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'deterministic-config.json'), JSON.stringify({ environmentPolicies: {}, serviceAliases: {} }));
    fs.writeFileSync(
      path.join(configDir, 'datasources.json'),
      JSON.stringify([
        {
          name: 'qa-orders',
          kind: 'mysql',
          env: 'qa',
          service: 'orders',
          tags: [],
          connection: { host: '127.0.0.1', port: 4406, database: 'orders' },
          credentialRef: 'qa:orders',
          connectors: ['openvpn'],
          resolverHints: { openvpnCredentialRef: 'vpn:work' },
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          updatedAt: new Date().toISOString(),
          confidence: 0.9,
        },
      ]),
    );
    setupKb(memoryRoot);
    const seedDatasource = runCli(['creds', 'set', '--ref', 'qa:orders', '--user', 'reader'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    });
    expect(seedDatasource.status).toBe(0);
    const seedConnector = runCli(['creds', 'set', '--ref', 'vpn:work', '--status-command', 'true'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    });
    expect(seedConnector.status).toBe(0);

    const out = runCli(['--json', 'self-check', '--agent', '--datasource', 'qa-orders'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    });
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.readiness).toBe('ready');
    expect(parsed.target.datasource).toBe('qa-orders');
  });

  it('exits 7 when self-check --agent is not ready', () => {
    const stateRoot = makeStateRoot();
    const memoryRoot = makeMemoryRoot();
    const out = runCli(['--json', 'self-check', '--agent'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    });
    expect(out.status).toBe(7);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.readiness).not.toBe('ready');
  });
});
