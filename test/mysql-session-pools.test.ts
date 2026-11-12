import mysql from 'mysql2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { closeAllMysqlPools, closeMysqlSessionPools, leaseMysqlConnection } from '../src/plugins-builtins/_shared/db-conn.js';
import { column, startFakeMysqlServer, type FakeMysqlServer } from './helpers/fake-mysql-server.js';

let server: FakeMysqlServer;

beforeAll(async () => {
  server = await startFakeMysqlServer(() => ({ columns: [column('profiles', 'ok', mysql.Types.LONG)], row: ['1'] }), () => undefined);
});

afterEach(closeAllMysqlPools);

afterAll(() => {
  server?.close();
});

async function readIn(sessionId: string): Promise<void> {
  const { conn, release } = await leaseMysqlConnection({ host: '127.0.0.1', port: server.port, user: 'reader', password: '' }, '+00:00', {
    capability: 'executeRead',
    sessionId,
    signal: undefined,
  });
  await conn.query('SELECT 1 AS ok');
  await release();
}

describe('MySQL session pools', () => {
  it('serves every read of a live session from one pooled connection', async () => {
    // act
    await readIn('live');
    await readIn('live');
    await readIn('live');

    // assert
    expect(await server.openConnections()).toBe(1);
  });

  it('ends the pool of an expired session and keeps the live session pooled', async () => {
    // arrange
    await readIn('expired');
    await readIn('live');

    // act
    await closeMysqlSessionPools('expired');

    // assert
    await vi.waitFor(async () => expect(await server.openConnections()).toBe(1));
    await readIn('live');
    expect(await server.openConnections()).toBe(1);
  });
});
