import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { outputData, outputDataRecord, outputError } from './helpers/cli-contract-envelopes.js';
import { parseJson } from './helpers/parse-json.js';
import { addProfile, setupEmptyState } from './helpers/datasource-crud-state.js';
import { runCli } from './helpers/cli.js';

const rowSchema = z.array(z.unknown());
const profileListSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(rowSchema),
  warnings: z.array(z.string()).optional(),
});
const storedProfilesSchema = z.array(z.looseObject({ name: z.string() }));
const shownConnectorsSchema = z.object({ connectors: z.array(z.string()), resolverHints: z.record(z.string(), z.string()) });

function profileNames(stdout: string): unknown[] {
  const { rows } = outputData(stdout, profileListSchema);
  return rows.map((row) => row[0]);
}

describe('datasource CRUD', () => {
  it('datasource add refuses --require-database without --database', () => {
    // arrange
    const { env } = setupEmptyState();

    // act
    const out = runCli(['datasource', 'add', '--name', 'qa-cache', '--kind', 'redis', '--env', 'qa', '--host', '127.0.0.1', '--port', '6379', '--require-database'], env);

    // assert
    expect(out.status).not.toBe(0);
    expect(`${out.stdout}${out.stderr}`).toContain('--require-database needs --database');
  });

  it('datasource add saves --require-database with --database', () => {
    // arrange
    const { env } = setupEmptyState();

    // act
    const out = runCli(['datasource', 'add', '--name', 'qa-cache', '--kind', 'redis', '--env', 'qa', '--host', '127.0.0.1', '--port', '6379', '--database', '2', '--require-database'], env);

    // assert
    expect(out.status).toBe(0);
  });

  it('saves the profile given to datasource add', () => {
    const { env } = setupEmptyState();
    const out = addProfile(env);
    expect(out.status).toBe(0);
  });

  it('shows a profile after it is added', () => {
    const { env } = setupEmptyState();
    addProfile(env);
    const out = runCli(['datasource', 'show', 'qa-svc'], env);
    expect(out.status).toBe(0);
    expect(outputDataRecord(out.stdout)).toMatchObject({ name: 'qa-svc', kind: 'mysql', env: 'qa' });
  });

  it('lists a profile after it is added', () => {
    const { env } = setupEmptyState();
    addProfile(env);
    const out = runCli(['datasource', 'list'], env);
    expect(out.status).toBe(0);
    expect(profileNames(out.stdout)).toContain('qa-svc');
  });

  it('datasource list filters by name and shows host and database', () => {
    const { env } = setupEmptyState();
    addProfile(env);
    const out = runCli(['datasource', 'list', 'SVC'], env);
    const none = runCli(['datasource', 'list', 'nomatch'], env);
    expect(outputDataRecord(out.stdout)).toStrictEqual({
      columns: ['name', 'kind', 'env', 'service', 'host', 'database'],
      rows: [['qa-svc', 'mysql', 'qa', 'svc', '127.0.0.1', 'svcdb']],
    });
    expect(outputDataRecord(none.stdout)).toStrictEqual({ columns: [], rows: [] });
  });

  it('datasource add --probe keeps the profile when plugin doctor fails', () => {
    // arrange
    const { env } = setupEmptyState();

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
    const { message } = outputError(out.stdout);
    expect(message).toContain('PROBE_FAILED');
    expect(message).toContain('Re-run: taproot doctor --datasource qa-probe --connect');
    expect(message).toContain('Remove: taproot datasource remove qa-probe');
    expect(runCli(['datasource', 'show', 'qa-probe'], env).status).toBe(0);
  });

  it('datasource add defaults --credential-ref to --env', () => {
    // arrange
    const { env } = setupEmptyState();

    // act
    const out = runCli(['datasource', 'add', '--name', 'qa-default', '--kind', 'mysql', '--env', 'qa', '--service', 'svc'], env);

    // assert
    expect(out.status).toBe(0);
    expect(outputDataRecord(out.stdout).credentialRef).toBe('qa');
  });

  it('datasource add without --env or --credential-ref is BAD_INPUT', () => {
    // arrange
    const { env } = setupEmptyState();

    // act
    const out = runCli(['datasource', 'add', '--name', 'bare', '--kind', 'mysql'], env);

    // assert
    expect(out.status).toBe(2);
    expect(outputError(out.stdout).message).toContain('--env or --credential-ref');
  });

  it('lists rows ordered by env, namespace, service and name', () => {
    const { env } = setupEmptyState();
    runCli(['datasource', 'add', '--name', 'qa-zeta', '--kind', 'mysql', '--credential-ref', 'qa:zeta', '--env', 'qa', '--service', 'zeta'], env);
    runCli(['datasource', 'add', '--name', 'qa-alpha', '--kind', 'mysql', '--credential-ref', 'qa:alpha', '--env', 'qa', '--service', 'alpha'], env);
    runCli(['datasource', 'add', '--name', 'prod-billing', '--kind', 'mysql', '--credential-ref', 'prod:billing', '--env', 'prod', '--service', 'billing'], env);
    runCli(['datasource', 'add', '--name', 'qa-beta-dev', '--kind', 'mysql', '--credential-ref', 'qa:beta', '--env', 'qa', '--namespace', 'develop', '--service', 'beta'], env);

    const out = runCli(['datasource', 'list'], env);
    expect(out.status).toBe(0);
    const { columns, rows } = outputData(out.stdout, profileListSchema);
    expect(columns).toContain('namespace');
    expect(rows.map((row) => row[0])).toStrictEqual(['prod-billing', 'qa-alpha', 'qa-zeta', 'qa-beta-dev']);
    const alphaRow = rows.find((row) => row[0] === 'qa-alpha');
    expect(alphaRow?.[columns.indexOf('namespace')]).toBeNull();
  });

  it('removes the profile so that show no longer finds it', () => {
    const { env } = setupEmptyState();
    addProfile(env);
    const removeOut = runCli(['datasource', 'remove', 'qa-svc'], env);
    const showOut = runCli(['datasource', 'show', 'qa-svc'], env);
    expect(removeOut.status).toBe(0);
    expect(showOut.status).toBe(1);
  });

  it('stores the connector commands given to datasource add', () => {
    const { env } = setupEmptyState();
    addProfile(env, ['--connector', 'kubectl-portforward', '--connector-ref', 'kubectl-portforward=kpf:qa:svc']);
    const out = runCli(['datasource', 'show', 'qa-svc'], env);
    expect(out.status).toBe(0);
    const shown = outputData(out.stdout, shownConnectorsSchema);
    expect(shown.connectors).toStrictEqual(['kubectl-portforward']);
    expect(shown.resolverHints['kubectl-portforwardCredentialRef']).toBe('kpf:qa:svc');
  });

  it('datasource add refuses to overwrite a datasources file that does not parse', () => {
    // arrange
    const { env, stateRoot } = setupEmptyState();
    const file = path.join(stateRoot, 'config', 'datasources.json');
    const torn = '[{"name":"qa-kept","kind":"mysql"';
    fs.writeFileSync(file, torn);

    // act
    const out = addProfile(env);

    // assert
    expect(out.status).not.toBe(0);
    expect(outputError(out.stdout).message).toContain(`${file} is not valid JSON`);
    expect(fs.readFileSync(file, 'utf8')).toBe(torn);
  });

  it('datasource list skips an invalid row, warns about it, and add keeps it', () => {
    // arrange
    const { env, stateRoot } = setupEmptyState();
    addProfile(env);
    const file = path.join(stateRoot, 'config', 'datasources.json');
    const stored = storedProfilesSchema.parse(parseJson(fs.readFileSync(file, 'utf8')));
    const broken = { ...stored[0], name: 'qa-broken', connection: { port: null } };
    fs.writeFileSync(file, JSON.stringify([...stored, broken]));

    // act
    const listed = runCli(['datasource', 'list'], env);
    addProfile(env, ['--port', '3307']);

    // assert
    const { rows, warnings } = outputData(listed.stdout, profileListSchema);
    expect(rows.map((row) => row[0])).toStrictEqual(['qa-svc']);
    expect(warnings).toHaveLength(1);
    expect(warnings?.[0]).toContain('qa-broken: connection.port');
    const names = storedProfilesSchema.parse(parseJson(fs.readFileSync(file, 'utf8'))).map((row) => row.name);
    expect(names.toSorted()).toStrictEqual(['qa-broken', 'qa-svc']);
  });

  it('exits BAD_INPUT and saves nothing for datasource add --port abc', () => {
    // arrange
    const { env, stateRoot } = setupEmptyState();

    // act
    const out = addProfile(env, ['--port', 'abc']);

    // assert
    expect(out.status).toBe(2);
    expect(outputError(out.stdout).message).toContain('connection.port');
    expect(fs.readFileSync(path.join(stateRoot, 'config', 'datasources.json'), 'utf8')).toBe('[]');
  });
});
