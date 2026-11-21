import mysql from 'mysql2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mysqlPlugin } from '../src/plugins-builtins/mysql/index.js';
import type { DatasourceProfile } from '../src/types/core.js';
import { column, startEndlessMysqlServer, type FakeMysqlServer } from './helpers/fake-mysql-server.js';

let server: FakeMysqlServer;

beforeAll(async () => {
  server = await startEndlessMysqlServer({ columns: [column('profiles', 'id', mysql.Types.LONG)], row: ['7'] });
});

afterAll(() => server?.close());

describe('MySQL row cap', () => {
  it('stops reading a result that never ends once it holds maxRows rows', async () => {
    // arrange
    const datasource = {
      name: 'qa-profiles',
      kind: 'mysql',
      connection: { host: '127.0.0.1', port: server.port, database: 'profiles' },
    } as DatasourceProfile;

    // act
    const result = await mysqlPlugin.execute!(
      {
        datasource,
        query: 'SELECT id FROM profiles',
        capability: 'executeRead',
        timeoutMs: 5_000,
        maxRows: 3,
        sessionTimeZone: '+00:00',
        signal: undefined,
      },
      { user: 'reader', password: '' },
    );

    // assert
    expect(result.result).toEqual({ columns: ['id'], rows: [[7], [7], [7]], truncated: true });
  });
});
