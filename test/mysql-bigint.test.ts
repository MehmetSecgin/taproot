import mysql from 'mysql2';
import { describe, expect, it } from 'vitest';
import { column, leaseFakeMysqlConnection, startFakeMysqlServer } from './helpers/fake-mysql-server.js';

const UNSIGNED_FLAG = 32;

const answerNoSetStatements = (): undefined => undefined;

describe('mysql BIGINT', () => {
  it('returns values beyond Number.MAX_SAFE_INTEGER as exact strings and small values as numbers', async () => {
    // arrange
    const server = await startFakeMysqlServer(() => ({
      columns: [
        column('accounts', 'id', mysql.Types.LONGLONG),
        { ...column('accounts', 'external_id', mysql.Types.LONGLONG), flags: UNSIGNED_FLAG },
        column('accounts', 'version', mysql.Types.LONGLONG),
      ],
      row: ['9007199254740993', '18446744073709551615', '42'],
    }), answerNoSetStatements);
    try {
      const { conn, release } = await leaseFakeMysqlConnection(server);

      // act
      const [rows] = await conn.query('SELECT id, external_id, version FROM accounts');
      await release();

      // assert
      expect(rows).toStrictEqual([{ id: '9007199254740993', external_id: '18446744073709551615', version: 42 }]);
    } finally {
      server.close();
    }
  });
});
