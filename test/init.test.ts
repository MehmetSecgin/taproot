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
    expect(Array.isArray(parsed.nextActions)).toBe(true);
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
    expect(datasources[0].name).toBe('qa-orders');
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
          name: 'qa-orders',
          kind: 'mysql',
          env: 'qa',
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
