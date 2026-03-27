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

function setupState() {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-doctor-bootstrap-'));
  const configDir = path.join(stateRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'datasources.json'), '[]');
  fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');
  fs.writeFileSync(path.join(configDir, 'deterministic-config.json'), JSON.stringify({}));

  const memoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-doctor-bootstrap-memory-'));
  const kbDir = path.join(memoryRoot, 'domains', 'engineering', 'references', 'db-kb');
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(
    path.join(kbDir, 'services.json'),
    JSON.stringify([
      {
        service: 'orders',
        connections: [
          {
            env: 'prod',
            engine: 'mysql',
            database: 'orders',
            db_user: 'reader',
            access_method: 'tsh',
            target: 'orders-tidb',
            status: 'active',
            verified_at_utc: '2026-03-01T00:00:00Z',
          },
        ],
      },
    ]),
  );

  return {
    stateRoot,
    configDir,
    env: {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_FORCE_DIRECT: '1',
      OBSIDIAN_MEMORY_ROOT: memoryRoot,
      PATH: '',
    },
  };
}

describe('doctor bootstrap', () => {
  it('reuses canonical KB bootstrap shape for env/service datasource creation', () => {
    const { configDir, env } = setupState();
    const out = runCli(['doctor', '--env', 'prod', '--service', 'orders'], env);
    expect(out.status).not.toBe(0);

    const datasources = JSON.parse(fs.readFileSync(path.join(configDir, 'datasources.json'), 'utf8'));
    expect(datasources).toHaveLength(1);
    expect(datasources[0]).toMatchObject({
      name: 'prod-orders',
      kind: 'teleport-mysql',
      env: 'prod',
      service: 'orders',
      tags: ['auto-bootstrap', 'kb-derived'],
      connection: {
        database: 'orders',
        target: 'orders-tidb',
      },
      credentialRef: 'prod:orders',
      connectors: ['openvpn', 'teleport'],
      resolverHints: {
        openvpnCredentialRef: 'vpn:work',
        teleportCredentialRef: 'tsh:prod',
      },
    });
  });
});
