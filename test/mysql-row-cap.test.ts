import mysql from 'mysql2';
import { describe, expect, it, vi } from 'vitest';
import { mysqlPlugin } from '../src/plugins-builtins/mysql/index.js';
import { column, startEndlessMysqlServer } from './helpers/fake-mysql-server.js';
import { executeOf, mysqlProfilesDatasource, startServerForTest } from './helpers/mysql-row-cap-support.js';

describe('mysql row cap', () => {
  it('stops reading a result that never ends once it holds maxRows rows', async () => {
    // arrange
    const server = await startServerForTest(async () => startEndlessMysqlServer({ columns: [column('profiles', 'id', mysql.Types.LONG)], row: ['7'] }));

    // act
    const result = await executeOf(mysqlPlugin)(
      {
        datasource: mysqlProfilesDatasource(server.port),
        query: 'SELECT id FROM profiles',
        capability: 'executeRead',
        timeoutMs: 5000,
        maxRows: 3,
        sessionTimeZone: '+00:00',
        signal: undefined,
      },
      { user: 'reader', password: '' },
    );

    // assert
    expect(result.result).toStrictEqual({ columns: ['id'], rows: [[7], [7], [7]], truncated: true });
    await vi.waitFor(
      async () => {
        await expect(server.openConnections()).resolves.toBe(0);
      },
      { timeout: 2000 },
    );
  });
});
