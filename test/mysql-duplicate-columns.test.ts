import mysql from 'mysql2';
import { describe, expect, it } from 'vitest';
import { mysqlPlugin } from '../src/plugins-builtins/mysql/index.js';
import { column, startFakeMysqlServer } from './helpers/fake-mysql-server.js';
import { answerWithoutError, executeOf, mysqlProfilesDatasource, startServerForTest } from './helpers/mysql-row-cap-support.js';

describe('mysql duplicate column names', () => {
  it('keeps the value of every column in select order', async () => {
    // arrange
    const server = await startServerForTest(async () =>
      startFakeMysqlServer(
        () => ({
          columns: [column('profiles', 'id', mysql.Types.LONG), column('addresses', 'id', mysql.Types.LONG)],
          row: ['7', '9'],
        }),
        answerWithoutError,
      ),
    );

    // act
    const result = await executeOf(mysqlPlugin)(
      {
        datasource: mysqlProfilesDatasource(server.port),
        query: 'SELECT p.id, a.id FROM profiles p JOIN addresses a ON a.profile_id = p.id',
        capability: 'executeRead',
        sessionTimeZone: '+00:00',
        signal: undefined,
      },
      { user: 'reader', password: '' },
    );

    // assert
    expect(result.result).toStrictEqual({ columns: ['id', 'id'], rows: [[7, 9]] });
  });
});
