import path from 'node:path';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { outputData, outputDataRecord, outputError } from './helpers/cli-contract-envelopes.js';
import { parseJson } from './helpers/parse-json.js';
import { runCli } from './helpers/cli.js';
import { writeRuntimeConfig } from './helpers/state-root.js';

const helpCommandSchema = z.object({ name: z.string() });
const helpDataSchema = z.object({ commands: z.array(helpCommandSchema) });
const packageSchema = z.object({ version: z.string() });

describe('cli contract', () => {
  it('prints root help with the nine commands', () => {
    const out = runCli(['--help']);
    expect(out.status).toBe(0);
    const { commands } = outputData(out.stdout, helpDataSchema);
    const names = commands.map((command) => command.name.split(' ')[0]);
    const nonHelpNames = names.filter((name) => name !== 'help').toSorted();
    expect(nonHelpNames).toStrictEqual(['creds', 'daemon', 'datasource', 'doctor', 'grpc', 'init', 'kb', 'query', 'schema']);
  });

  it('prints the version as JSON', async () => {
    const packageText = await readFile(new URL('../package.json', import.meta.url), 'utf8');
    const pkg = packageSchema.parse(parseJson(packageText));
    const out = runCli(['--version']);
    expect(out.status).toBe(0);
    expect(parseJson(out.stdout)).toStrictEqual({ version: pkg.version });
  });

  it('rejects the removed learning commands', () => {
    const out = runCli(['learn', 'status']);
    expect(out.status).not.toBe(0);
    expect(outputError(out.stdout).code).toBe('CLI_ERROR');
  });

  it('returns bad-input exit code for unknown option', () => {
    const out = runCli(['creds', 'set', '--ref', 'x', '--host', 'localhost']);
    expect(out.status).toBe(2);
    const { message } = outputError(out.stdout);
    expect(message.toLowerCase()).toContain('unknown option');
    expect(message).toContain('taproot datasource add');
  });

  it('enforces prod no-guess mode unless discovery is explicit', () => {
    const stateRoot = path.join(os.tmpdir(), `taproot-${Date.now()}`);
    writeRuntimeConfig(stateRoot, {
      environmentPolicies: {
        prod: {
          deterministicRequired: true,
          allowDiscoveryByDefault: false,
        },
      },
    });
    const out = runCli(
      ['query', '--env', 'prod', '--service', 'missing', '--sql', 'SELECT 1 AS ok'],
      { TAPROOT_FORCE_DIRECT: '1', TAPROOT_STATE_ROOT: stateRoot },
    );
    expect(out.status).toBe(2);
    expect(out.stdout.toLowerCase()).toContain('deterministic_required');
  });

  it('resolves service aliases from runtime config in cache and kb commands', () => {
    const stateRoot = path.join(os.tmpdir(), `taproot-alias-${Date.now()}`);
    const configDir = path.join(stateRoot, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    writeRuntimeConfig(stateRoot, {
      serviceAliases: {
        legacyservice: 'sample-service',
      },
    });
    fs.writeFileSync(
      path.join(configDir, 'deterministic-config.json'),
      JSON.stringify({
        serviceAliases: {
          legacyservice: 'sample-service',
        },
      }),
    );
    const kbDir = path.join(stateRoot, 'kb');
    fs.mkdirSync(kbDir, { recursive: true });
    fs.writeFileSync(
      path.join(kbDir, 'services.json'),
      JSON.stringify([
        {
          service: 'sample-service',
          connections: [
            {
              env: 'sandbox',
              engine: 'mysql',
              database: 'orders',
              db_user: 'sample_reader',
              access_method: 'native',
              status: 'active',
              verified_at_utc: '2026-03-01T00:00:00Z',
            },
          ],
        },
      ]),
    );
    const kbOut = runCli(['kb', 'resolve', '--service', 'legacyservice', '--env', 'sandbox'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_KB_DIR: kbDir,
    });
    expect(kbOut.status).toBe(0);
    expect(outputDataRecord(kbOut.stdout).service).toBe('sample-service');
  });
});
