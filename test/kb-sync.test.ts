import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { qaPortforwardLocalPort } from '../src/core/qa-portforward.js';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';

function kbWith(services: unknown): Record<string, string> {
  const { stateRoot } = tempStateRoot();
  const kbDir = path.join(stateRoot, 'kb');
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'services.json'), JSON.stringify(services));
  return {
    TAPROOT_STATE_ROOT: stateRoot,
    TAPROOT_MASTER_KEY: 'test-key',
    TAPROOT_KB_DIR: kbDir,
  };
}

const orders = {
  service: 'orders',
  connections: [
    {
      env: 'qa',
      engine: 'mysql',
      database: 'orders',
      db_user: 'orders_reader',
      access_method: 'tsh',
      target: 'orders-mysql',
      status: 'active',
      verified_at_utc: '2026-03-10T00:00:00Z',
    },
  ],
};

describe('datasource sync --from-kb', () => {
  it('dry-run lists the profiles it would create and saves nothing', () => {
    // arrange
    const env = kbWith([orders]);

    // act
    const out = runCli(['datasource', 'sync', '--from-kb', '--env', 'qa', '--dry-run'], env);

    // assert
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).data).toMatchObject({ dryRun: true, created: ['qa-orders'], skipped: [] });
    expect(runCli(['datasource', 'show', 'qa-orders'], env).status).not.toBe(0);
  });

  it('creates a teleport profile from a tsh row with its target and db user', () => {
    // arrange
    const env = kbWith([orders]);

    // act
    const out = runCli(['datasource', 'sync', '--from-kb', '--env', 'qa'], env);

    // assert
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).data.created).toEqual(['qa-orders']);
    const shown = JSON.parse(runCli(['datasource', 'show', 'qa-orders'], env).stdout).data;
    expect(shown).toMatchObject({
      kind: 'teleport-mysql',
      env: 'qa',
      service: 'orders',
      connection: { target: 'orders-mysql', database: 'orders' },
      credentialRef: 'qa',
      resolverHints: { dbUser: 'orders_reader' },
      policy: { allowMutate: false },
    });
  });

  it('points a qa-portforward row at its local forwarded port', () => {
    // arrange
    const row = { ...orders, connections: [{ ...orders.connections[0], access_method: 'qa-portforward', target: undefined, namespace: 'develop' }] };
    const env = kbWith([row]);

    // act
    runCli(['datasource', 'sync', '--from-kb', '--env', 'qa'], env);

    // assert
    const shown = JSON.parse(runCli(['datasource', 'show', 'qa-develop-orders'], env).stdout).data;
    expect(shown.kind).toBe('mysql');
    expect(shown.connection).toMatchObject({ host: '127.0.0.1', port: qaPortforwardLocalPort('qa', 'develop', 'orders') });
  });

  it('skips a native row that has no host and says why', () => {
    // arrange
    const payments = {
      service: 'payments',
      connections: [{ env: 'qa', engine: 'mysql', database: 'payments', access_method: 'native', status: 'active', verified_at_utc: '2026-03-01T00:00:00Z' }],
    };
    const env = kbWith([payments]);

    // act
    const out = runCli(['datasource', 'sync', '--from-kb', '--env', 'qa'], env);

    // assert
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).data).toMatchObject({ created: [], skipped: [{ name: 'qa-payments', reason: expect.stringMatching(/host/) }] });
  });

  it('never overwrites an existing profile', () => {
    // arrange
    const env = kbWith([orders]);
    runCli(['datasource', 'sync', '--from-kb', '--env', 'qa'], env);

    // act
    const out = runCli(['datasource', 'sync', '--from-kb', '--env', 'qa'], env);

    // assert
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).data).toMatchObject({ created: [], skipped: [{ name: 'qa-orders', reason: expect.stringMatching(/exists/) }] });
  });

  it('requires --env', () => {
    // arrange
    const env = kbWith([orders]);

    // act
    const out = runCli(['datasource', 'sync', '--from-kb'], env);

    // assert
    expect(out.status).not.toBe(0);
  });
});
