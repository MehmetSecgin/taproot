import type { AddressInfo, Server } from 'node:net';
import mysql from 'mysql2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { leaseMysqlConnection } from '../src/plugins-builtins/_shared/db-conn.js';

interface ServerConnection {
  sequenceId: number;
  on(event: string, listener: () => void): void;
  serverHandshake(args: Record<string, unknown>): void;
  writeOk(): void;
  writeColumns(columns: unknown[]): void;
  writeTextRow(row: unknown[]): void;
  writeEof(): void;
}

interface FakeMysqlServer {
  _server: Server;
  listen(port: number, host: string, onListening: () => void): void;
  close(): void;
}

const TIMESTAMP_COLUMN = {
  catalog: 'def',
  schema: '',
  table: 'orders',
  orgTable: 'orders',
  name: 'created_at',
  orgName: 'created_at',
  characterSet: 63,
  columnLength: 19,
  columnType: mysql.Types.TIMESTAMP,
  flags: 0,
  decimals: 0,
};

let servedTimestamp = '';
let server: FakeMysqlServer;
let port = 0;

function reply(conn: ServerConnection, write: () => void): void {
  conn.sequenceId = 1;
  write();
  conn.sequenceId = 0;
}

beforeAll(async () => {
  vi.stubEnv('TZ', 'Asia/Tokyo');
  server = mysql.createServer((conn) => {
    const client = conn as unknown as ServerConnection;
    client.on('error', () => undefined);
    client.serverHandshake({
      protocolVersion: 10,
      serverVersion: '8.0.0',
      connectionId: 1,
      statusFlags: 2,
      characterSet: 8,
      capabilityFlags: 0xffffff,
      authCallback: (_params: unknown, accept: () => void) => {
        accept();
        client.sequenceId = 0;
      },
    });
    client.on('stmt_prepare', () => reply(client, () => client.writeOk()));
    client.on('query', () =>
      reply(client, () => {
        client.writeColumns([TIMESTAMP_COLUMN]);
        client.writeTextRow([servedTimestamp]);
        client.writeEof();
      }),
    );
  }) as unknown as FakeMysqlServer;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server._server.address() as AddressInfo).port;
});

afterAll(() => {
  server?.close();
  vi.unstubAllEnvs();
});

async function selectCreatedAt(sessionTimeZone: string): Promise<unknown> {
  const { conn, release } = await leaseMysqlConnection({ host: '127.0.0.1', port, user: 'reader', password: '' }, sessionTimeZone, false);
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
