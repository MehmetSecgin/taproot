import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function runCli(args: string[], env: Record<string, string>) {
  const distCli = path.join(process.cwd(), 'dist', 'index.js');
  return spawnSync(process.execPath, [distCli, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function setupStateRoot() {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-connector-'));
  const configDir = path.join(stateRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'datasources.json'),
    JSON.stringify([
      {
        name: 'qa-demo',
        kind: 'mysql',
        env: 'qa',
        service: 'demo',
        tags: [],
        connection: { host: '127.0.0.1', port: 3306, database: 'demo' },
        credentialRef: 'qa:demo',
        connectors: ['openvpn'],
        policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
        resolverHints: {},
        updatedAt: new Date().toISOString(),
        confidence: 0.9,
      },
    ]),
  );
  return {
    stateRoot,
    env: {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-master-key',
    },
  };
}

describe('connector UX', () => {
  it('connector setup stores connector refs/commands without raw creds workflow', () => {
    const { env } = setupStateRoot();
    const setupOut = runCli(
      [
        '--json',
        'connector',
        'setup',
        '--datasource',
        'qa-demo',
        '--connector',
        'openvpn',
        '--status-command',
        'true',
        '--connect-command',
        'true',
      ],
      env,
    );
    expect(setupOut.status).toBe(0);
    const parsed = JSON.parse(setupOut.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.connector).toBe('openvpn');
    expect(parsed.data.ref).toContain('openvpn:');
  });

  it('connector status runs connector doctor checks and returns summary', () => {
    const { env } = setupStateRoot();
    runCli(
      [
        'connector',
        'setup',
        '--datasource',
        'qa-demo',
        '--connector',
        'openvpn',
        '--status-command',
        'true',
        '--connect-command',
        'true',
      ],
      env,
    );
    const statusOut = runCli(['--json', 'connector', 'status', '--datasource', 'qa-demo'], env);
    expect(statusOut.status).toBe(0);
    const parsed = JSON.parse(statusOut.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.data.summary.total).toBeGreaterThan(0);
    expect(parsed.data.checks[0].check).toContain('openvpn');
  });

  it('doctor emits connector setup next-action hints for missing connector config', () => {
    const { env } = setupStateRoot();
    const out = runCli(['--json', 'doctor', '--datasource', 'qa-demo'], env);
    expect(out.status).not.toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(Array.isArray(parsed.nextActions)).toBe(true);
    expect(parsed.nextActions.join('\n')).toContain('taproot doctor --datasource qa-demo --connect');
  });
});
