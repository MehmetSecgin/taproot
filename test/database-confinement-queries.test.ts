import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeQuery, silentQueryReport } from '../src/core/execute-query.js';
import type { TargetDiscovery } from '../src/core/resolve-datasource.js';
import { queryDatasourceResolver } from '../src/core/resolve-query-datasource.js';
import { rpcCall } from '../src/daemon/client.js';
import { useDatabaseConfinement } from './helpers/database-confinement-env.js';
import { startLocalDaemon } from './helpers/daemon.js';
import { fakePlugin, interceptExecute } from './helpers/fake-plugin.js';
import { contextWith, queryRequest, setupQueryState } from './helpers/query-state.js';

const NO_TARGET_DISCOVERY: TargetDiscovery | undefined = undefined;

describe('database confinement where queries run', () => {
  useDatabaseConfinement();

  const shopProfile = { kind: 'mysql', connection: { host: '127.0.0.1', port: 1, database: 'shop' } };

  it('refuses a cross-schema query before it reaches the plugin', async () => {
    // arrange
    await setupQueryState(shopProfile);
    const sent: string[] = [];
    const plugin = interceptExecute(fakePlugin({ kind: 'mysql' }), (request) => {
      sent.push(request.query);
    });
    const ctx = contextWith(plugin);

    // act
    const outcome = await executeQuery(queryRequest({ query: 'SELECT * FROM other.refunds' }), {
      ctx,
      report: silentQueryReport,
      signal: undefined,
      acquireQuerySlot: undefined,
      resolveDatasource: queryDatasourceResolver(NO_TARGET_DISCOVERY),
    });

    // assert
    expect(outcome).toMatchObject({ ok: false, code: 'DATABASE_CONFINED', details: { reached: 'other' } });
    expect(sent.filter((query) => query.includes('other'))).toStrictEqual([]);
  });

  it('still serves schema.read from the catalog of the profile database', async () => {
    // arrange
    const stateRoot = await setupQueryState(shopProfile);
    const socketPath = path.join(stateRoot, 'run', 'taprootd-confined.sock');
    const plugin = fakePlugin({ kind: 'mysql', columns: ['table_name', 'column_name'], rows: [['orders', 'id']] });
    const daemon = await startLocalDaemon({ stateRoot, socketPath, plugins: [plugin] });

    try {
      // act
      const res = await rpcCall({ socketPath, method: 'schema.read', params: { datasource: 'qa-fake', tables: ['orders'] } });

      // assert
      expect(res.data).toStrictEqual({ tables: { orders: { columns: ['id'] } } });
    } finally {
      await daemon.stop();
    }
  });
});
