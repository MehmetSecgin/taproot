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

  const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-doctor-bootstrap-kb-'));
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
      TAPROOT_KB_DIR: kbDir,
      PATH: '',
    },
  };
}

describe('doctor with an unresolved env/service target', () => {
  it('writes no datasource profile and no credentials', () => {
    // arrange
    const { configDir, env } = setupState();

    // act
    const out = runCli(['doctor', '--env', 'prod', '--service', 'orders'], env);

    // assert
    expect(out.status).not.toBe(0);
    expect(JSON.parse(fs.readFileSync(path.join(configDir, 'datasources.json'), 'utf8'))).toEqual([]);
    expect(fs.existsSync(path.join(configDir, 'credentials.json.enc'))).toBe(false);
  });

  it('reports the missing profile and that the KB can supply it', () => {
    // arrange
    const { env } = setupState();

    // act
    const out = runCli(['doctor', '--env', 'prod', '--service', 'orders'], env);

    // assert
    expect(out.status).toBe(7);
    const parsed = JSON.parse(out.stdout).data;
    expect(parsed.datasource).toBe(null);
    expect(parsed.checks.find((check: { check: string }) => check.check === 'target_datasource')).toMatchObject({
      status: 'fail',
    });
    expect(parsed.checks.find((check: { check: string }) => check.check === 'kb routing')).toMatchObject({
      status: 'ok',
    });
  });

  it('warns when the KB has no connection for the target', () => {
    // arrange
    const { env } = setupState();

    // act
    const out = runCli(['doctor', '--env', 'prod', '--service', 'payments'], env);

    // assert
    expect(out.status).toBe(7);
    const parsed = JSON.parse(out.stdout).data;
    expect(parsed.checks.find((check: { check: string }) => check.check === 'kb routing')).toMatchObject({
      status: 'warn',
    });
  });
});
