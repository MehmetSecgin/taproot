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
  const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-datasource-kb-'));
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'services.json'), '[]');
  return {
    stateRoot,
    kbDir,
    env: {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_KB_DIR: kbDir,
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
    const out = runCli(['datasource', 'show', 'qa-svc'], env);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).data).toMatchObject({ name: 'qa-svc', kind: 'mysql', env: 'qa' });
  });

  it('datasource list includes profile', () => {
    const { env } = setupState();
    addProfile(env);
    const out = runCli(['datasource', 'list'], env);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).data.some((row: { name: string }) => row.name === 'qa-svc')).toBe(true);
  });

  it('datasource add --probe keeps the profile when plugin doctor fails', () => {
    // arrange
    const { env } = setupState();

    // act
    const out = runCli(
      [
        'datasource', 'add',
        '--name', 'qa-probe',
        '--kind', 'mysql',
        '--credential-ref', 'qa:probe',
        '--env', 'qa', '--service', 'probe',
        '--host', '127.0.0.1', '--port', '1', '--database', 'probedb',
        '--probe',
      ],
      env,
    );

    // assert
    expect(out.status).not.toBe(0);
    const error = JSON.parse(out.stdout).error;
    expect(error.message).toContain('PROBE_FAILED');
    expect(error.message).toContain('Re-run: taproot doctor --datasource qa-probe --connect');
    expect(error.message).toContain('Remove: taproot datasource remove qa-probe');
    expect(runCli(['datasource', 'show', 'qa-probe'], env).status).toBe(0);
  });

  it('datasource add defaults --credential-ref to --env', () => {
    // arrange
    const { env } = setupState();

    // act
    const out = runCli(['datasource', 'add', '--name', 'qa-default', '--kind', 'mysql', '--env', 'qa', '--service', 'svc'], env);

    // assert
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).data.credentialRef).toBe('qa');
  });

  it('datasource add without --env or --credential-ref is BAD_INPUT', () => {
    // arrange
    const { env } = setupState();

    // act
    const out = runCli(['datasource', 'add', '--name', 'bare', '--kind', 'mysql'], env);

    // assert
    expect(out.status).toBe(2);
    expect(JSON.parse(out.stdout).error.message).toContain('--env or --credential-ref');
  });

  it('datasource list orders rows by env, namespace, service, name', () => {
    const { env } = setupState();
    runCli(['datasource', 'add', '--name', 'qa-zeta', '--kind', 'mysql', '--credential-ref', 'qa:zeta', '--env', 'qa', '--service', 'zeta'], env);
    runCli(['datasource', 'add', '--name', 'qa-alpha', '--kind', 'mysql', '--credential-ref', 'qa:alpha', '--env', 'qa', '--service', 'alpha'], env);
    runCli(['datasource', 'add', '--name', 'prod-billing', '--kind', 'mysql', '--credential-ref', 'prod:billing', '--env', 'prod', '--service', 'billing'], env);
    runCli(['datasource', 'add', '--name', 'qa-beta-dev', '--kind', 'mysql', '--credential-ref', 'qa:beta', '--env', 'qa', '--namespace', 'develop', '--service', 'beta'], env);

    const out = runCli(['datasource', 'list'], env);
    expect(out.status).toBe(0);
    const rows = JSON.parse(out.stdout).data as Array<{ name: string; env: string; namespace: string; service: string }>;
    expect(rows.map((r) => r.name)).toEqual(['prod-billing', 'qa-alpha', 'qa-zeta', 'qa-beta-dev']);
  });

  it('datasource remove deletes profile', () => {
    const { env } = setupState();
    addProfile(env);
    const removeOut = runCli(['datasource', 'remove', 'qa-svc'], env);
    const showOut = runCli(['datasource', 'show', 'qa-svc'], env);
    expect(removeOut.status).toBe(0);
    expect(showOut.status).toBe(1);
  });

  it('datasource resolve by env+service', () => {
    const { env } = setupState();
    addProfile(env);
    const out = runCli(['datasource', 'resolve', '--env', 'qa', '--service', 'svc'], env);
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout).data;
    expect(parsed.source).toBe('datasource-store');
    expect(parsed.profile.name).toBe('qa-svc');
  });

  it('datasource resolve by env+namespace+service prefers exact namespace match', () => {
    const { env } = setupState();
    addProfile(env, ['--namespace', 'develop']);
    runCli(
      [
        'datasource',
        'add',
        '--name',
        'qa-svc-test',
        '--kind',
        'mysql',
        '--credential-ref',
        'qa:svc',
        '--env',
        'qa',
        '--namespace',
        'test',
        '--service',
        'svc',
        '--host',
        '127.0.0.1',
        '--port',
        '3306',
        '--database',
        'svcdb',
      ],
      env,
    );
    const out = runCli(['datasource', 'resolve', '--env', 'qa', '--namespace', 'develop', '--service', 'svc'], env);
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout).data;
    expect(parsed.profile).toMatchObject({ name: 'qa-svc', namespace: 'develop' });
  });

  it('datasource resolve from KB saves canonical bootstrap shape', () => {
    const { env, stateRoot, kbDir } = setupState();
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

    const out = runCli(['datasource', 'resolve', '--env', 'prod', '--service', 'orders'], env);
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout).data;
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
      credentialRef: 'prod',
      connectors: ['teleport'],
      resolverHints: {
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
    addProfile(env, ['--connector', 'kubectl-portforward', '--connector-ref', 'kubectl-portforward=kpf:qa:svc']);
    const out = runCli(['datasource', 'show', 'qa-svc'], env);
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout).data;
    expect(parsed.connectors).toEqual(['kubectl-portforward']);
    expect(parsed.resolverHints['kubectl-portforwardCredentialRef']).toBe('kpf:qa:svc');
  });

  it('datasource add with confidence', () => {
    const { env } = setupState();
    addProfile(env, ['--confidence', '0.5']);
    const out = runCli(['datasource', 'show', 'qa-svc'], env);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).data.confidence).toBe(0.5);
  });
});
