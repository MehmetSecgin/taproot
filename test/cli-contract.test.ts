import path from 'node:path';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import { describe, expect, it } from 'vitest';

function runCli(args: string[], env: Record<string, string> = {}) {
  const distCli = path.join(process.cwd(), 'dist', 'index.js');
  return spawnSync(process.execPath, [distCli, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function writeRuntimeConfig(stateRoot: string, config: Record<string, unknown>) {
  const configDir = path.join(stateRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'deterministic-config.json'), JSON.stringify(config));
}

describe('cli contract', () => {
  it('prints root help with stable commands', () => {
    const out = runCli(['--help']);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('Universal query orchestration CLI');
    expect(out.stdout).toContain('self-check');
    expect(out.stdout).toContain('doctor');
    expect(out.stdout).toContain('query');
    expect(out.stdout).toContain('datasource');
    expect(out.stdout).toContain('kb');
    expect(out.stdout).toContain('daemon');
    expect(out.stdout).toContain('session');
    expect(out.stdout).toContain('init');
    expect(out.stdout).toContain('discover');
    expect(out.stdout).toContain('grpc');
  });

  it('prints the version as JSON', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    const out = runCli(['--version']);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ version: pkg.version });
  });

  it('rejects the removed learning commands', () => {
    const out = runCli(['learn', 'status']);
    expect(out.status).not.toBe(0);
    expect(JSON.parse(out.stdout).error.code).toBe('CLI_ERROR');
  });

  it('self-check json includes checks', () => {
    const out = runCli(['self-check']);
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(Array.isArray(parsed.checks)).toBe(true);
  });

  it('returns bad-input exit code for unknown option', () => {
    const out = runCli(['creds', 'set', '--ref', 'x', '--host', 'localhost']);
    expect(out.status).toBe(2);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.error.message.toLowerCase()).toContain('unknown option');
    expect(parsed.error.message).toContain('taproot datasource add');
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
    expect(JSON.parse(kbOut.stdout).service).toBe('sample-service');
  });
});
