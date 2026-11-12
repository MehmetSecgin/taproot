import mysql from 'mysql2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { leaseMysqlConnection } from '../src/plugins-builtins/_shared/db-conn.js';
import { column, startFakeMysqlServer, type FakeMysqlServer } from './helpers/fake-mysql-server.js';

const UNSIGNED_FLAG = 32;

let server: FakeMysqlServer;

beforeAll(async () => {
  server = await startFakeMysqlServer(() => ({
    columns: [
      column('accounts', 'id', mysql.Types.LONGLONG),
      column('accounts', 'external_id', mysql.Types.LONGLONG, UNSIGNED_FLAG),
      column('accounts', 'version', mysql.Types.LONGLONG),
    ],
    row: ['9007199254740993', '18446744073709551615', '42'],
  }));
});

afterAll(() => server?.close());

describe('MySQL BIGINT', () => {
  it('returns values beyond Number.MAX_SAFE_INTEGER as exact strings and small values as numbers', async () => {
    // arrange
    const { conn, release } = await leaseMysqlConnection({ host: '127.0.0.1', port: server.port, user: 'reader', password: '' }, '+00:00', false);

    // act
    const [rows] = await conn.query('SELECT id, external_id, version FROM accounts').finally(release);

    // assert
    expect(rows).toEqual([{ id: '9007199254740993', external_id: '18446744073709551615', version: 42 }]);
  });
});
