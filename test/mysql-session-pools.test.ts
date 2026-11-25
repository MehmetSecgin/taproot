import mysql from 'mysql2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeAllMysqlPools, closeMysqlSessionPools } from '../src/plugins-builtins/_shared/mysql-connection-lease.js';
import { column, leaseFakeMysqlConnection, startFakeMysqlServer } from './helpers/fake-mysql-server.js';
import type { FakeMysqlServer } from './helpers/fake-mysql-server.js';
import { answerWithoutError, startServerForTest } from './helpers/mysql-row-cap-support.js';

async function startServer(): Promise<FakeMysqlServer> {
  return startServerForTest(async () =>
    startFakeMysqlServer(() => ({ columns: [column('profiles', 'ok', mysql.Types.LONG)], row: ['1'] }), answerWithoutError),
  );
}

async function readIn(server: FakeMysqlServer, sessionId: string): Promise<void> {
  const { conn, release } = await leaseFakeMysqlConnection(server, { sessionId });
  await conn.query('SELECT 1 AS ok');
  await release();
}

describe('mysql session pools', () => {
  afterEach(closeAllMysqlPools);

  it('serves every read of a live session from one pooled connection', async () => {
    // arrange
    const server = await startServer();

    // act
    await readIn(server, 'live');
    await readIn(server, 'live');
    await readIn(server, 'live');

    // assert
    await expect(server.openConnections()).resolves.toBe(1);
  });

  it('ends the pool of an expired session and keeps the live session pooled', async () => {
    // arrange
    const server = await startServer();
    await readIn(server, 'expired');
    await readIn(server, 'live');

    // act
    await closeMysqlSessionPools('expired');

    // assert
    await vi.waitFor(async () => {
      await expect(server.openConnections()).resolves.toBe(1);
    });
    await readIn(server, 'live');
    await expect(server.openConnections()).resolves.toBe(1);
  });
});
