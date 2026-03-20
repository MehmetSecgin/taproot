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

describe('teleport mysql execution', () => {
  it('fails cleanly without tsh db exec fallback when proxy path is unavailable', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-teleport-'));
    const configDir = path.join(stateRoot, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'datasources.json'),
      JSON.stringify([
        {
          name: 'prod-orders',
          kind: 'teleport-mysql',
          env: 'prod',
          service: 'orders',
          tags: [],
          connection: { target: 'orders-tidb', database: 'orders' },
          credentialRef: 'prod:orders',
          connectors: [],
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          resolverHints: {},
          updatedAt: new Date().toISOString(),
          confidence: 0.9,
        },
      ]),
    );
    fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');
    const baseEnv = {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_FORCE_DIRECT: '1',
    };
    const seed = runCli(['creds', 'set', '--ref', 'prod:orders', '--db-user', 'reader'], baseEnv);
    expect(seed.status).toBe(0);
    const out = runCli(
      ['query', '--datasource', 'prod-orders', '--query', 'SELECT 1 AS ok'],
      {
        ...baseEnv,
        PATH: '',
      },
    );
    expect(out.status).toBe(3);
    expect(out.stderr).toContain('teleport proxy path unavailable');
    expect(out.stderr).not.toContain('tsh db exec');
    expect(out.stderr).not.toContain('fallback');
  });
});
