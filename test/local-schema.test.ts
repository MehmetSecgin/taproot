import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rpcCall } from '../src/daemon/client.js';
import { DatasourceStore } from '../src/store/datasources.js';
import { runCli } from './helpers/cli.js';
import { startLocalDaemon } from './helpers/daemon.js';
import { fakePlugin } from './helpers/fake-plugin.js';
import { restoreQueryEnv, setupQueryState } from './helpers/query-state.js';
import { tempStateRoot } from './helpers/state-root.js';

afterEach(restoreQueryEnv);

describe('schema on the local daemon', () => {
  it('answers schema.read from the catalog of a configured datasource', async () => {
    // arrange
    const stateRoot = await setupQueryState({ kind: 'mysql' });
    const socketPath = path.join(stateRoot, 'run', 'taprootd-schema.sock');
    const plugin = fakePlugin({ kind: 'mysql', columns: ['table_name', 'column_name'], rows: [['orders', 'id']] });
    const daemon = await startLocalDaemon({ stateRoot, socketPath, plugins: [plugin] });

    try {
      // act
      const res = await rpcCall({ socketPath, method: 'schema.read', params: { datasource: 'qa-fake', tables: ['orders'] } });

      // assert
      expect(res.data).toEqual({ tables: { orders: { columns: ['id'] } } });
    } finally {
      await daemon.stop();
    }
  });
});

describe('taproot schema', () => {
  it('answers through the daemon it starts, with the error alone', () => {
    // arrange
    const { stateRoot, configDir } = tempStateRoot();
    new DatasourceStore(path.join(configDir, 'datasources.json')).save({
      name: 'qa-cache',
      kind: 'redis',
      env: 'qa',
      service: 'cache',
      tags: [],
      connection: { host: '127.0.0.1', port: 1 },
      credentialRef: 'qa:cache',
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      updatedAt: new Date().toISOString(),
      confidence: 1,
    });
    const env = { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-master-key' };

    try {
      // act
      const res = runCli(['schema', '--datasource', 'qa-cache'], env);
      const daemon = runCli(['daemon', 'status'], env);

      // assert
      expect(JSON.parse(res.stdout)).toEqual({ ok: false, error: { code: 'BAD_INPUT', message: "BAD_INPUT: 'qa-cache' is a redis datasource; only SQL datasources have a schema." } });
      expect(res.status).toBe(2);
      expect(daemon.status).toBe(0);
    } finally {
      runCli(['daemon', 'stop'], env);
    }
  });

  it('names a datasource that has no profile', () => {
    // arrange
    const { stateRoot } = tempStateRoot();

    // act
    const res = runCli(['schema', '--datasource', 'qa-nope'], { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_FORCE_DIRECT: '1' });

    // assert
    expect(res.stdout.trim().split('\n')).toHaveLength(1);
    expect(JSON.parse(res.stdout).error.code).toBe('UNKNOWN_DATASOURCE');
  });
});
