import mysql from 'mysql2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mysqlPlugin } from '../src/plugins-builtins/mysql/index.js';
import type { DatasourceProfile } from '../src/types/core.js';
import { column, startFakeMysqlServer, type FakeMysqlServer } from './helpers/fake-mysql-server.js';

let server: FakeMysqlServer;

beforeAll(async () => {
  server = await startFakeMysqlServer(() => ({
    columns: [column('profiles', 'id', mysql.Types.LONG), column('addresses', 'id', mysql.Types.LONG)],
    row: ['7', '9'],
  }), () => undefined);
});

afterAll(() => server?.close());

describe('MySQL duplicate column names', () => {
  it('keeps the value of every column in select order', async () => {
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
        query: 'SELECT p.id, a.id FROM profiles p JOIN addresses a ON a.profile_id = p.id',
        capability: 'executeRead',
        sessionTimeZone: '+00:00',
      },
      { user: 'reader', password: '' },
    );

    // assert
    expect(result.result).toEqual({ columns: ['id', 'id'], rows: [[7, 9]] });
  });
});
