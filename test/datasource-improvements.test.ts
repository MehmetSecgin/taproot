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
  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-improve-kb-'));
  const kbDir = path.join(memoryRoot, 'domains', 'engineering', 'references', 'db-kb');
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'services.json'), '[]');
  return { stateRoot, env: { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key', OBSIDIAN_MEMORY_ROOT: memoryRoot } };
}

describe('--probe runs connector connect before the DB probe', () => {
  it('rolls back and reports the connector failure (not a DB error)', () => {
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

    // assert — probe failed on the connector and rolled the profile back
    expect(out.status).not.toBe(0);
    expect(out.stderr + out.stdout).toContain('PROBE_FAILED');
    expect(out.stderr + out.stdout).toContain('kubectl-portforward');
    expect(runCli(['datasource', 'show', 'svc-probe'], env).status).toBe(1);
  });
});

describe('self-check audits dangling credentialRefs', () => {
  it('warns when a datasource references a credential ref that is not set, and clears once set', () => {
    // arrange
    const { env } = setupState();
    runCli(['datasource', 'add', '--name', 'svc-a', '--kind', 'mysql', '--credential-ref', 'missing-ref',
            '--host', '127.0.0.1', '--port', '3306', '--database', 'd'], env);

    // act
    const before = JSON.parse(runCli(['--json', 'self-check', '--agent'], env).stdout);
    const check = before.checks.find((c: { check: string }) => c.check === 'credential_refs');

    // assert
    expect(check.status).toBe('warn');
    expect(check.detail).toContain('missing-ref');

    // act — set the ref, re-check
    runCli(['creds', 'set', '--ref', 'missing-ref', '--user', 'reader', '--password', 'p'], env);
    const after = JSON.parse(runCli(['--json', 'self-check', '--agent'], env).stdout);
    const okCheck = after.checks.find((c: { check: string }) => c.check === 'credential_refs');
    expect(okCheck.status).toBe('ok');
  });
});

describe('datasource export / import', () => {
  it('round-trips profiles through export then import --file', () => {
    // arrange
    const { stateRoot, env } = setupState();
    runCli(['datasource', 'add', '--name', 'svc-x', '--kind', 'mysql', '--credential-ref', 'db:x',
            '--env', 'qa', '--service', 'x', '--host', '127.0.0.1', '--port', '3306', '--database', 'xdb'], env);
    const exported = runCli(['--json', 'datasource', 'export'], env);
    expect(exported.status).toBe(0);
    expect(JSON.parse(exported.stdout).data).toHaveLength(1);
    const dumpFile = path.join(stateRoot, 'dump.json');
    fs.writeFileSync(dumpFile, exported.stdout);

    // act — wipe and re-import from the exported envelope
    runCli(['datasource', 'remove', 'svc-x'], env);
    const imported = runCli(['--json', 'datasource', 'import', '--file', dumpFile], env);

    // assert
    expect(imported.status).toBe(0);
    const result = JSON.parse(imported.stdout).data;
    expect(result.imported).toEqual(['svc-x']);
    expect(runCli(['--json', 'datasource', 'show', 'svc-x'], env).status).toBe(0);
  });
});
