import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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

function setupState() {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-policy-'));
  const configDir = path.join(stateRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'deterministic-config.json'),
    JSON.stringify({
      environmentPolicies: {
        careful: {
          deterministicRequired: true,
          allowDiscoveryByDefault: false,
          preferredAccessMethods: ['tsh'],
          targetPreference: ['tidb', 'mysql'],
        },
      },
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
      { service: 'orders', connections: [] },
      { service: 'sample-service', connections: [] },
    ]),
  );
  return {
    env: {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_KB_DIR: kbDir,
    },
  };
}

describe('runtime policy and KB state', () => {

  it('lists KB services', () => {
    const { env } = setupState();
    const out = runCli(['kb', 'list-services'], env);
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual(['orders', 'sample-service']);
  });
});
