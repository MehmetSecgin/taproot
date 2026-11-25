import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { outputCheckNamed, outputDataRecord } from './helpers/cli-contract-envelopes.js';
import { runCli } from './helpers/cli.js';
import { setupEmptyState } from './helpers/datasource-crud-state.js';

describe('--probe runs connector connect before the DB probe', () => {
  it('keeps the profile and reports the connector failure (not a DB error)', () => {
    // arrange
    const { env } = setupEmptyState();
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
    const { env } = setupEmptyState();
    runCli(['datasource', 'add', '--name', 'svc-a', '--kind', 'mysql', '--credential-ref', 'missing-ref',
            '--host', '127.0.0.1', '--port', '3306', '--database', 'd'], env);

    // act
    const before = outputCheckNamed(runCli(['init'], env).stdout, 'credential_refs');
    runCli(['creds', 'set', '--ref', 'missing-ref', '--user', 'reader', '--password', 'p'], env);
    const after = outputCheckNamed(runCli(['init'], env).stdout, 'credential_refs');

    // assert
    expect(before?.status).toBe('warn');
    expect(before?.detail).toContain('missing-ref');
    expect(after?.status).toBe('ok');
  });
});

describe('datasource import', () => {
  it('imports a profile read back from datasource show', () => {
    // arrange
    const { stateRoot, env } = setupEmptyState();
    runCli(['datasource', 'add', '--name', 'svc-x', '--kind', 'mysql', '--credential-ref', 'db:x',
            '--env', 'qa', '--service', 'x', '--host', '127.0.0.1', '--port', '3306', '--database', 'xdb'], env);
    const shown = runCli(['datasource', 'show', 'svc-x', '--pluck', 'data'], env);
    expect(shown.status).toBe(0);
    const dumpFile = path.join(stateRoot, 'dump.json');
    fs.writeFileSync(dumpFile, `[${shown.stdout}]`);

    // act
    runCli(['datasource', 'remove', 'svc-x'], env);
    const imported = runCli(['datasource', 'import', '--file', dumpFile], env);

    // assert
    expect(imported.status).toBe(0);
    expect(outputDataRecord(imported.stdout).imported).toStrictEqual(['svc-x']);
    expect(runCli(['datasource', 'show', 'svc-x'], env).status).toBe(0);
  });
});
