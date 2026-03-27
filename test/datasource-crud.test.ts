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
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-datasource-'));
  const configDir = path.join(stateRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'datasources.json'), '[]');
  fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');
  fs.writeFileSync(path.join(configDir, 'deterministic-config.json'), '{}');
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-datasource-memory-'));
  const kbDir = path.join(memoryRoot, 'domains', 'engineering', 'references', 'db-kb');
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'services.json'), '[]');
  return {
    stateRoot,
    memoryRoot,
    env: {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    },
  };
}

function addProfile(env: Record<string, string>, extra: string[] = []) {
  return runCli(
    [
      'datasource',
      'add',
      '--name',
      'qa-svc',
      '--kind',
      'mysql',
      '--credential-ref',
      'qa:svc',
      '--env',
      'qa',
      '--service',
      'svc',
      '--host',
      '127.0.0.1',
      '--port',
      '3306',
      '--database',
      'svcdb',
      ...extra,
    ],
    env,
  );
}

describe('datasource CRUD', () => {
  it('datasource add creates profile', () => {
    const { env } = setupState();
    const out = addProfile(env);
    expect(out.status).toBe(0);
  });

  it('datasource show returns added profile', () => {
    const { env } = setupState();
    addProfile(env);
    const out = runCli(['--json', 'datasource', 'show', '--name', 'qa-svc'], env);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ name: 'qa-svc', kind: 'mysql', env: 'qa' });
  });

  it('datasource list includes profile', () => {
    const { env } = setupState();
    addProfile(env);
    const out = runCli(['--json', 'datasource', 'list'], env);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).some((row: { name: string }) => row.name === 'qa-svc')).toBe(true);
  });

  it('datasource remove deletes profile', () => {
    const { env } = setupState();
    addProfile(env);
    const removeOut = runCli(['datasource', 'remove', '--name', 'qa-svc'], env);
    const showOut = runCli(['datasource', 'show', '--name', 'qa-svc'], env);
    expect(removeOut.status).toBe(0);
    expect(showOut.status).toBe(1);
  });

  it('datasource resolve by env+service', () => {
    const { env } = setupState();
    addProfile(env);
    const out = runCli(['--json', 'datasource', 'resolve', '--env', 'qa', '--service', 'svc'], env);
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.source).toBe('datasource-store');
    expect(parsed.profile.name).toBe('qa-svc');
  });

  it('datasource resolve from KB saves canonical bootstrap shape', () => {
    const { env, stateRoot, memoryRoot } = setupState();
    const kbDir = path.join(memoryRoot, 'domains', 'engineering', 'references', 'db-kb');
    fs.writeFileSync(
      path.join(kbDir, 'services.json'),
      JSON.stringify([
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
      ]),
    );

    const out = runCli(['--json', 'datasource', 'resolve', '--env', 'prod', '--service', 'orders'], env);
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.source).toBe('kb');
    expect(parsed.profile).toMatchObject({
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

    const saved = JSON.parse(fs.readFileSync(path.join(stateRoot, 'config', 'datasources.json'), 'utf8'));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      name: 'prod-orders',
      kind: 'teleport-mysql',
      tags: ['auto-bootstrap', 'kb-derived'],
    });
  });

  it('datasource add with connectors', () => {
    const { env } = setupState();
    addProfile(env, ['--connector', 'openvpn', '--connector-ref', 'openvpn=openvpn:qa:svc']);
    const out = runCli(['--json', 'datasource', 'show', '--name', 'qa-svc'], env);
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.connectors).toEqual(['openvpn']);
    expect(parsed.resolverHints.openvpnCredentialRef).toBe('openvpn:qa:svc');
  });

  it('datasource add with confidence', () => {
    const { env } = setupState();
    addProfile(env, ['--confidence', '0.5']);
    const out = runCli(['--json', 'datasource', 'show', '--name', 'qa-svc'], env);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).confidence).toBe(0.5);
  });
});
