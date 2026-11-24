import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { outputData, outputError } from './helpers/cli-contract-envelopes.js';
import { parseJson } from './helpers/parse-json.js';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';

const CLI_SURFACES = [[], ['--version'], ['--help'], ['query', '--help'], ['daemon'], ['nosuch'], ['query', '--bogus'], ['--json', 'datasource', 'list']];

const credentialValuesSchema = z.object({ values: z.record(z.string(), z.string()) });
const profileNameSchema = z.object({ name: z.string() });

function setupStateRoot(): string {
  const { stateRoot, configDir } = tempStateRoot();
  fs.writeFileSync(
    path.join(configDir, 'datasources.json'),
    JSON.stringify([
      {
        name: 'qa-orders',
        kind: 'mysql',
        env: 'qa',
        service: 'orders',
        tags: [],
        connection: { host: '127.0.0.1', port: 3306, database: 'orders' },
        credentialRef: 'qa:orders',
        connectors: [],
        policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
        resolverHints: {},
        updatedAt: new Date().toISOString(),
      },
    ]),
  );
  return stateRoot;
}

describe('output mode contract', () => {
  it('prints JSON by default', () => {
    // arrange
    const env = { TAPROOT_STATE_ROOT: setupStateRoot(), TAPROOT_MASTER_KEY: 'test-key' };

    // act
    const shown = runCli(['datasource', 'show', 'qa-orders'], env);
    const removedCommand = runCli(['learn', 'status'], env);

    // assert
    expect(outputData(shown.stdout, profileNameSchema).name).toBe('qa-orders');
    expect(() => parseJson(removedCommand.stdout)).not.toThrow();
  });

  it('rejects the removed --json flag', () => {
    // act
    const out = runCli(['--json', 'datasource', 'list']);

    // assert
    expect(out.status).not.toBe(0);
    expect(outputError(out.stdout).code).toBe('CLI_ERROR');
  });

  it('names the replacement for a flag or command removed in 1.0', () => {
    // act
    const removedFlag = runCli(['--json', 'datasource', 'list']);
    const removedCommand = runCli(['daemon', 'start']);
    const unknownFlag = runCli(['query', '--bogus']);

    // assert
    expect(outputError(removedFlag.stdout).message).toMatch(/removed in 1\.0: output is always one line of compact JSON/u);
    expect(outputError(removedCommand.stdout).message).toMatch(/removed in 1\.0: the first taproot query starts the daemon/u);
    expect(outputError(unknownFlag.stdout).message).toBe("error: unknown option '--bogus'");
  });

  it('names the owning subcommand for a query option placed before it', () => {
    // act
    const out = runCli(['--timeout', '5000', 'query', '--sql', 'SELECT 1']);

    // assert
    expect(out.status).not.toBe(0);
    expect(outputError(out.stdout).message).toBe("error: unknown option '--timeout'. option '--timeout' belongs to 'taproot query'; put it after the subcommand: taproot query --timeout ...");
  });

  it('names the owner without placement advice for a query option after another subcommand', () => {
    // act
    const out = runCli(['datasource', 'list', '--timeout', '5000']);

    // assert
    expect(outputError(out.stdout).message).toBe("error: unknown option '--timeout'. '--timeout' is an option of 'taproot query'");
  });

  it('names the owner without placement advice for a query option before another subcommand', () => {
    // act
    const out = runCli(['--timeout', '5000', 'doctor']);

    // assert
    expect(outputError(out.stdout).message).toBe("error: unknown option '--timeout'. '--timeout' is an option of 'taproot query'");
  });

  it('says to split an option and value that arrive as one argument', () => {
    // act
    const out = runCli(['query', '--datasource qa-orders', '--sql', 'SELECT 1']);

    // assert
    expect(outputError(out.stdout).message).toContain("option '--datasource' and its value arrived as one argument");
  });

  it('rejects --sql and --query together', () => {
    // act
    const out = runCli(['query', '--datasource', 'qa-orders', '--sql', 'SELECT 1', '--query', 'SELECT 2']);

    // assert
    expect(outputError(out.stdout).code).toBe('BAD_INPUT');
  });

  it.each(CLI_SURFACES)('prints exactly one JSON document and nothing on stderr for taproot %s', (...args) => {
    // act
    const out = runCli(args);

    // assert
    expect(out.stderr).toBe('');
    expect(out.stdout.trim().split('\n')).toHaveLength(1);
    expect(() => parseJson(out.stdout)).not.toThrow();
  });

  it('prints CLI errors as a JSON envelope', () => {
    // act
    const out = runCli(['query', '--bogus']);

    // assert
    expect(out.status).not.toBe(0);
    expect(outputError(out.stdout).code).toBe('CLI_ERROR');
  });

  it('masks stored credentials in JSON output', () => {
    // arrange
    const env = { TAPROOT_STATE_ROOT: setupStateRoot(), TAPROOT_MASTER_KEY: 'test-key' };
    const seeded = runCli(['creds', 'set', '--ref', 'qa:orders', '--user', 'qa_user', '--password', 'secret'], env);

    // act
    const shown = runCli(['creds', 'show', '--ref', 'qa:orders'], env);

    // assert
    expect(seeded.status).toBe(0);
    const { values } = outputData(shown.stdout, credentialValuesSchema);
    expect(values.user).toBe('qa_user');
    expect(values.password).toBe('[REDACTED]');
  });
});
