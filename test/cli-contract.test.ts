import path from 'node:path';
import fs from 'node:fs';
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
    expect(out.stdout).toContain('template');
    expect(out.stdout).toContain('card');
    expect(out.stdout).toContain('kb');
    expect(out.stdout).toContain('daemon');
    expect(out.stdout).toContain('session');
    expect(out.stdout).toContain('init');
    expect(out.stdout).toContain('onboard');
  });

  it('prints skill version', () => {
    const out = runCli(['--skill-version']);
    expect(out.status).toBe(0);
    expect(out.stdout.trim()).toBe('taproot-skill@0.1.0');
  });

  it('completion zsh includes command name', () => {
    const out = runCli(['completion', 'zsh']);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('compdef _taproot_complete taproot');
  });

  it('completion root suggestions are driven by command tree', () => {
    const out = runCli(['__complete', 'con']);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('connector');
  });

  it('learn help includes schema snapshot command', () => {
    const out = runCli(['learn', '--help']);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain('schema');
    expect(out.stdout).toContain('ensure-schema');
  });

  it('provides dynamic datasource/template completion entries', () => {
    const stateRoot = path.join(os.tmpdir(), `taproot-complete-${Date.now()}`);
    const configDir = path.join(stateRoot, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'datasources.json'),
      JSON.stringify([
        {
          name: 'qa-orders',
          kind: 'mysql',
          env: 'qa',
          service: 'orders',
          tags: [],
          connection: {},
          credentialRef: 'qa:orders',
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          updatedAt: new Date().toISOString(),
          confidence: 1,
        },
      ]),
    );
    fs.writeFileSync(
      path.join(configDir, 'templates.json'),
      JSON.stringify([
        {
          id: 'orders.latest',
          datasourceKind: 'mysql',
          intent: 'latest orders',
          aliases: [],
          nativeQueryTemplate: 'SELECT 1 AS ok',
          params: [],
          resultShape: 'table',
          tags: [],
          status: 'active',
          verifiedAt: new Date().toISOString(),
        },
      ]),
    );
    const outDs = runCli(['__complete', 'query', '--datasource', 'qa'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
    });
    expect(outDs.status).toBe(0);
    expect(outDs.stdout).toContain('qa-orders');

    const outTpl = runCli(['__complete', 'query', '--template', 'orders'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
    });
    expect(outTpl.status).toBe(0);
    expect(outTpl.stdout).toContain('orders.latest');
  });

  it('self-check json includes checks', () => {
    const out = runCli(['--json', 'self-check']);
    expect(out.status).toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(Array.isArray(parsed.checks)).toBe(true);
  });

  it('returns bad-input exit code for unknown option', () => {
    const out = runCli(['creds', 'set', '--ref', 'x', '--host', 'localhost']);
    expect(out.status).toBe(2);
    expect(out.stderr.toLowerCase()).toContain('unknown option');
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
      ['query', '--env', 'prod', '--service', 'missing', '--query', 'SELECT 1 AS ok'],
      { TAPROOT_FORCE_DIRECT: '1', TAPROOT_STATE_ROOT: stateRoot },
    );
    expect(out.status).toBe(2);
    expect((out.stderr || '').toLowerCase()).toContain('deterministic_required');
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
    const memoryRoot = path.join(stateRoot, 'memory-root');
    const kbDir = path.join(memoryRoot, 'domains', 'engineering', 'references', 'db-kb');
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
    const kbOut = runCli(['--json', 'kb', 'resolve-database-name', '--service', 'legacyservice', '--env', 'sandbox'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
    });
    expect(kbOut.status).toBe(0);
    expect(JSON.parse(kbOut.stdout).service).toBe('sample-service');
  });
});
