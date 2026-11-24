import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { describe, expect, it } from 'vitest';
import { outputCheckNamed, outputDataRecord } from './helpers/cli-contract-envelopes.js';
import { parseJson } from './helpers/parse-json.js';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';

function setupState(): { stateRoot: string; configDir: string; env: Record<string, string> } {
  const { stateRoot, configDir } = tempStateRoot();
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
    const savedDatasources = parseJson(fs.readFileSync(path.join(configDir, 'datasources.json'), 'utf8'));
    expect(savedDatasources).toStrictEqual([]);
    expect(fs.readdirSync(configDir)).not.toContain('credentials.json.enc');
  });

  it('reports the missing profile and that the KB can supply it', () => {
    // arrange
    const { env } = setupState();

    // act
    const out = runCli(['doctor', '--env', 'prod', '--service', 'orders'], env);

    // assert
    expect(out.status).toBe(7);
    expect(Object.keys(outputDataRecord(out.stdout))).toStrictEqual(['checks', 'summary']);
    expect(outputCheckNamed(out.stdout, 'target_datasource')).toMatchObject({
      status: 'fail',
    });
    expect(outputCheckNamed(out.stdout, 'kb routing')).toMatchObject({
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
    expect(outputCheckNamed(out.stdout, 'kb routing')).toMatchObject({
      status: 'warn',
    });
  });
});
