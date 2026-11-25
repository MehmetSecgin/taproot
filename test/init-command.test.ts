import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  cliEnv,
  createEmptyKbDir,
  createOrdersKbDir,
  findCheck,
  parseFailureOutput,
  parseInitOutput,
  parseServiceListOutput,
  readJsonFileAsUnknown,
  readSavedKbDir,
} from './helpers/init-fixtures.js';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';

const VALID_REDIS_PROFILE = {
  name: 'qa-cache',
  kind: 'redis',
  env: 'qa',
  service: 'cache',
  tags: [],
  connection: { host: '127.0.0.1', port: 6379 },
  credentialRef: 'qa:cache',
  policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
  updatedAt: new Date().toISOString(),
};

function runInitWithOrdersKb(): ReturnType<typeof runCli> {
  const { stateRoot } = tempStateRoot();
  return runCli(['init'], cliEnv(stateRoot, createOrdersKbDir()));
}

function stateRootWithOneAddedDatasource(addArgs: string[]): { env: Record<string, string> } {
  const { stateRoot } = tempStateRoot();
  const env = cliEnv(stateRoot, createOrdersKbDir());
  runCli(['init'], env);
  const added = runCli(['datasource', 'add', ...addArgs, '--env', 'qa', '--host', '127.0.0.1'], env);
  expect(added.status).toBe(0);
  return { env };
}

describe('init command', () => {
  it('reports a malformed datasources.json as a failed check instead of throwing', () => {
    // arrange
    const { stateRoot, configDir } = tempStateRoot();
    fs.writeFileSync(path.join(configDir, 'datasources.json'), '{"not": "an array"}');

    // act
    const out = runCli(['init'], cliEnv(stateRoot, createOrdersKbDir()));

    // assert
    expect(out.status).toBe(0);
    const { data } = parseInitOutput(out.stdout);
    const datasourcesCheck = findCheck(data, 'datasources');
    expect(datasourcesCheck?.status).toBe('fail');
    expect(datasourcesCheck?.detail).toContain('must hold a JSON array of datasource profiles');
    expect(data.readiness).toBe('missing_datasource');
  });

  it('counts valid profiles toward readiness and warns about skipped rows', () => {
    // arrange
    const { stateRoot, configDir } = tempStateRoot();
    fs.writeFileSync(path.join(configDir, 'datasources.json'), JSON.stringify([VALID_REDIS_PROFILE, { name: 'qa-broken', kind: 'mysql' }]));

    // act
    const out = runCli(['init'], cliEnv(stateRoot, createOrdersKbDir()));

    // assert
    expect(out.status).toBe(0);
    const { data } = parseInitOutput(out.stdout);
    expect(data.readiness).toBe('ready');
    expect(findCheck(data, 'datasources')).toStrictEqual({ check: 'datasources', status: 'ok' });
    const skippedCheck = findCheck(data, 'skipped_datasources');
    expect(skippedCheck?.status).toBe('warn');
    expect(skippedCheck?.detail).toContain('skipped invalid datasource qa-broken');
  });

  it('creates starter config with environmentPolicies and serviceAliases', () => {
    // arrange
    const { stateRoot } = tempStateRoot();
    const kbDir = createOrdersKbDir();

    // act
    const out = runCli(['init'], cliEnv(stateRoot, kbDir));

    // assert
    expect(out.status).toBe(0);
    const configFile = path.join(stateRoot, 'config', 'deterministic-config.json');
    expect(readJsonFileAsUnknown(configFile)).toStrictEqual({
      environmentPolicies: {},
      serviceAliases: {},
      kbDir,
    });
  });

  it('saves --kb-dir so later commands find the KB without TAPROOT_KB_DIR', () => {
    // arrange
    const { stateRoot } = tempStateRoot();
    const kbDir = createOrdersKbDir();
    const env = cliEnv(stateRoot, '');

    // act
    const init = runCli(['init', '--kb-dir', kbDir], env);
    const list = runCli(['kb', 'list-services'], env);

    // assert
    expect(init.status).toBe(0);
    expect(parseInitOutput(init.stdout).data.savedKbDir).toBe(kbDir);
    expect(list.status).toBe(0);
    expect(parseServiceListOutput(list.stdout).data).toStrictEqual(['orders']);
  });

  it('keeps a saved kbDir when TAPROOT_KB_DIR points elsewhere', () => {
    // arrange
    const { stateRoot } = tempStateRoot();
    const savedKbDir = createOrdersKbDir();
    runCli(['init', '--kb-dir', savedKbDir], cliEnv(stateRoot, ''));

    // act
    const out = runCli(['init'], cliEnv(stateRoot, createEmptyKbDir()));

    // assert
    expect(out.status).toBe(0);
    expect(readSavedKbDir(stateRoot)).toBe(savedKbDir);
  });

  it('fails KB commands with KB_MISSING naming the directory when no KB is set up', () => {
    // arrange
    const { stateRoot } = tempStateRoot();
    const env = cliEnv(stateRoot, '');
    const expectedDir = path.join(stateRoot, 'kb');

    // act
    const resolve = runCli(['kb', 'resolve', '--env', 'qa', '--service', 'orders'], env);
    const initDatasource = runCli(['init', 'datasource', '--env', 'qa', '--service', 'orders'], env);

    // assert
    for (const out of [resolve, initDatasource]) {
      expect(out.status).toBe(7);
      const { error } = parseFailureOutput(out.stdout);
      expect(error.code).toBe('KB_MISSING');
      expect(error.message).toContain(`KB directory ${expectedDir} does not exist`);
      expect(error.message).toContain('taproot init --kb-dir <dir>');
    }
  });

  it('leaves the saved config unchanged when init runs a second time', () => {
    // arrange
    const { stateRoot } = tempStateRoot();
    const env = cliEnv(stateRoot, createOrdersKbDir());
    const configFile = path.join(stateRoot, 'config', 'deterministic-config.json');
    expect(runCli(['init'], env).status).toBe(0);
    const before = fs.readFileSync(configFile, 'utf8');

    // act
    const second = runCli(['init'], env);

    // assert
    expect(second.status).toBe(0);
    expect(fs.readFileSync(configFile, 'utf8')).toBe(before);
  });

  it('reports a missing KB directory as a stable readiness state', () => {
    // arrange
    const { stateRoot } = tempStateRoot();

    // act
    const out = runCli(['init'], cliEnv(stateRoot, createEmptyKbDir()));

    // assert
    expect(out.status).toBe(0);
    const { data } = parseInitOutput(out.stdout);
    expect(findCheck(data, 'kb_dir')?.status).not.toBe('ok');
    expect(data.readiness).toBe('missing_kb');
  });

  it('reports credentials as optional when only redis datasources are configured', () => {
    // arrange
    const { env } = stateRootWithOneAddedDatasource(['--name', 'cache', '--kind', 'redis', '--service', 'cache', '--port', '6379', '--credential-ref', 'qa:redis:cache']);

    // act
    const out = runCli(['init'], env);

    // assert
    expect(out.status).toBe(0);
    expect(findCheck(parseInitOutput(out.stdout).data, 'credentials')?.status).toBe('ok');
  });

  it('does not ask for credentials when every datasource kind is auth-free', () => {
    // arrange
    const { env } = stateRootWithOneAddedDatasource(['--name', 'pilot', '--kind', 'grpc', '--service', 'profile', '--port', '6565', '--credential-ref', 'pilot']);

    // act
    const out = runCli(['init'], env);

    // assert
    expect(out.status).toBe(0);
    expect(findCheck(parseInitOutput(out.stdout).data, 'credentials')?.status).toBe('ok');
  });

  it('treats a missing master key as optional', () => {
    // arrange
    const { stateRoot } = tempStateRoot();

    // act
    const out = runCli(['init'], { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_KB_DIR: createOrdersKbDir() });

    // assert
    expect(out.status).toBe(0);
    expect(findCheck(parseInitOutput(out.stdout).data, 'master_key')?.status).toBe('ok');
  });

  it('warns when the credential file uses the key derived from $USER', () => {
    // arrange
    const { stateRoot } = tempStateRoot();
    const env = { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_KB_DIR: createOrdersKbDir(), TAPROOT_MASTER_KEY: '', TAPROOT_NO_KEYCHAIN: '1' };
    runCli(['creds', 'set', '--ref', 'qa:orders', '--user', 'qa_user', '--password', 'secret123'], env);

    // act
    const out = runCli(['init'], env);

    // assert
    expect(out.status).toBe(0);
    const masterKeyCheck = findCheck(parseInitOutput(out.stdout).data, 'master_key');
    expect(masterKeyCheck?.status).toBe('warn');
    expect(masterKeyCheck?.detail).toContain('TAPROOT_MASTER_KEY');
  });

  it('prints the init summary as JSON', () => {
    // act
    const out = runInitWithOrdersKb();

    // assert
    expect(out.status).toBe(0);
    const { data } = parseInitOutput(out.stdout);
    expect(data.checks).toBeInstanceOf(Array);
    expect(data.readiness).toBeTypeOf('string');
  });
});
