import mysql from 'mysql2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { leaseMysqlConnection } from '../src/plugins-builtins/_shared/db-conn.js';
import { column, startFakeMysqlServer, type FakeMysqlServer } from './helpers/fake-mysql-server.js';

let servedTimestamp = '';
let server: FakeMysqlServer;

beforeAll(async () => {
  vi.stubEnv('TZ', 'Asia/Tokyo');
  server = await startFakeMysqlServer(() => ({
    columns: [column('orders', 'created_at', mysql.Types.TIMESTAMP)],
    row: [servedTimestamp],
  }));
});

afterAll(() => {
  server?.close();
  vi.unstubAllEnvs();
});

async function selectCreatedAt(sessionTimeZone: string): Promise<unknown> {
  const { conn, release } = await leaseMysqlConnection({ host: '127.0.0.1', port: server.port, user: 'reader', password: '' }, sessionTimeZone, false);
  try {
    const [rows] = await conn.query('SELECT created_at FROM orders');
    return (rows as Array<{ created_at: unknown }>)[0].created_at;
  } finally {
    await release();
  }
}

describe('MySQL session time zone', () => {
  it.each([
    ['+00:00', '2026-11-07 10:42:00'],
    ['+05:30', '2026-11-07 16:12:00'],
  ])('reads a TIMESTAMP the server renders in %s as the instant it names', async (sessionTimeZone, rendered) => {
    // arrange
    servedTimestamp = rendered;

    // act
    const createdAt = await selectCreatedAt(sessionTimeZone);

    // assert
    expect((createdAt as Date).toISOString()).toBe('2026-11-07T10:42:00.000Z');
  });

  it('keeps the server wall clock for a named session zone', async () => {
    // arrange
    servedTimestamp = '2026-11-07 11:42:00';

    // act
    const createdAt = await selectCreatedAt('Europe/Berlin');

    // assert
    expect(createdAt).toBe('2026-11-07 11:42:00');
  });
});
