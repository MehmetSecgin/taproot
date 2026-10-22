import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function runCli(args: string[], env: Record<string, string> = {}) {
  const distCli = path.join(process.cwd(), 'dist', 'index.js');
  return spawnSync(process.execPath, [distCli, ...args], { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, ...env } });
}

function setupState() {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-improve-'));
  const configDir = path.join(stateRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'datasources.json'), '[]');
  fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');
  fs.writeFileSync(path.join(configDir, 'deterministic-config.json'), '{}');
  const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-improve-kb-'));
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'services.json'), '[]');
  return { stateRoot, env: { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key', TAPROOT_KB_DIR: kbDir } };
}

describe('--probe runs connector connect before the DB probe', () => {
  it('keeps the profile and reports the connector failure (not a DB error)', () => {
    // arrange — a connector whose connect command fails
    const { env } = setupState();
    runCli(['creds', 'set', '--ref', 'kpf:test', '--status-command', 'false', '--connect-command', 'false'], env);

    // act
    const out = runCli(
      ['datasource', 'add', '--name', 'svc-probe', '--kind', 'mysql', '--credential-ref', 'db:svc',
       '--host', '127.0.0.1', '--port', '3306', '--database', 'svcdb',
       '--connector', 'kubectl-portforward', '--connector-ref', 'kubectl-portforward=kpf:test', '--probe'],
      env,
    );

    // assert
    expect(out.status).not.toBe(0);
    expect(out.stderr + out.stdout).toContain('PROBE_FAILED');
    expect(out.stderr + out.stdout).toContain('kubectl-portforward');
    expect(runCli(['datasource', 'show', 'svc-probe'], env).status).toBe(0);
  });
});

describe('init audits dangling credentialRefs', () => {
  it('warns when a datasource references a credential ref that is not set, and clears once set', () => {
    // arrange
    const { env } = setupState();
    runCli(['datasource', 'add', '--name', 'svc-a', '--kind', 'mysql', '--credential-ref', 'missing-ref',
            '--host', '127.0.0.1', '--port', '3306', '--database', 'd'], env);

    // act
    const before = JSON.parse(runCli(['init'], env).stdout).data;
    const check = before.checks.find((c: { check: string }) => c.check === 'credential_refs');

    // assert
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('missing-ref');

    // act — set the ref, re-check
    runCli(['creds', 'set', '--ref', 'missing-ref', '--user', 'reader', '--password', 'p'], env);
    const after = JSON.parse(runCli(['init'], env).stdout).data;
    const okCheck = after.checks.find((c: { check: string }) => c.check === 'credential_refs');
    expect(okCheck.status).toBe('ok');
  });
});

describe('datasource import', () => {
  it('imports a profile read back from datasource show', () => {
    // arrange
    const { stateRoot, env } = setupState();
    runCli(['datasource', 'add', '--name', 'svc-x', '--kind', 'mysql', '--credential-ref', 'db:x',
            '--env', 'qa', '--service', 'x', '--host', '127.0.0.1', '--port', '3306', '--database', 'xdb'], env);
    const shown = runCli(['datasource', 'show', 'svc-x', '--pluck', 'data'], env);
    expect(shown.status).toBe(0);
    const dumpFile = path.join(stateRoot, 'dump.json');
    fs.writeFileSync(dumpFile, `[${shown.stdout}]`);

    // act — wipe and re-import
    runCli(['datasource', 'remove', 'svc-x'], env);
    const imported = runCli(['datasource', 'import', '--file', dumpFile], env);

    // assert
    expect(imported.status).toBe(0);
    const result = JSON.parse(imported.stdout).data;
    expect(result.imported).toEqual(['svc-x']);
    expect(runCli(['datasource', 'show', 'svc-x'], env).status).toBe(0);
  });
});
