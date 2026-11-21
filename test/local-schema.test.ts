import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rpcCall } from '../src/daemon/client.js';
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
      expect(res.data).toEqual({ tables: { orders: { database: 'fake', columns: ['id'], primaryKey: [], indexes: [] } } });
    } finally {
      await daemon.stop();
    }
  });
});

describe('taproot schema', () => {
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
