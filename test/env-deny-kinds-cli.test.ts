import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';

function setupDeniedMysql(denyKinds: string[]): Record<string, string> {
  const { stateRoot, configDir } = tempStateRoot();
  fs.writeFileSync(path.join(configDir, 'deterministic-config.json'), JSON.stringify({ environmentPolicies: { qa: { denyKinds } } }));
  return {
    TAPROOT_STATE_ROOT: stateRoot,
    TAPROOT_MASTER_KEY: 'test-key',
  };
}

const addOrders = ['datasource', 'add', '--name', 'qa-orders', '--kind', 'mysql', '--env', 'qa', '--service', 'orders', '--host', '127.0.0.1', '--port', '1', '--database', 'orders'];

describe('denyKinds on doctor and probe', () => {
  it('doctor reports a denied kind as a failed check and contacts nothing', () => {
    // arrange
    const env = setupDeniedMysql(['mysql']);
    runCli(addOrders, env);

    // act
    const out = runCli(['doctor', '--datasource', 'qa-orders'], env);

    // assert
    expect(out.status).not.toBe(0);
    expect(out.stdout).toMatch(/environmentPolicies\.denyKinds/);
    expect(out.stdout).not.toMatch(/ECONNREFUSED|connect/i);
  });

  it('doctor runs normally when the kind is not denied', () => {
    // arrange
    const env = setupDeniedMysql(['kafka']);
    runCli(addOrders, env);

    // act
    const out = runCli(['doctor', '--datasource', 'qa-orders'], env);

    // assert
    expect(out.stdout).not.toMatch(/denyKinds/);
  });

  it('datasource add --probe refuses a denied kind without calling the plugin', () => {
    // arrange
    const env = setupDeniedMysql(['mysql']);

    // act
    const out = runCli([...addOrders, '--probe'], env);

    // assert
    expect(out.status).not.toBe(0);
    expect(out.stdout + out.stderr).toMatch(/denyKinds/);
    expect(out.stdout + out.stderr).not.toMatch(/ECONNREFUSED/);
  });
});
