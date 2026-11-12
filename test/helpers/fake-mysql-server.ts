import type { AddressInfo, Server } from 'node:net';
import mysql from 'mysql2';

interface ServerConnection {
  sequenceId: number;
  on(event: string, listener: (sql: string) => void): void;
  serverHandshake(args: Record<string, unknown>): void;
  writeOk(): void;
  writeError(error: { code: number; message: string }): void;
  writeColumns(columns: unknown[]): void;
  writeTextRow(row: unknown[]): void;
  writeEof(): void;
}

interface MysqlServer {
  _server: Server;
  listen(port: number, host: string, onListening: () => void): void;
  close(): void;
}

interface ServedRow {
  columns: unknown[];
  row: unknown[];
}

export interface FakeMysqlError {
  errno: number;
  message: string;
}

export interface FakeMysqlServer {
  port: number;
  close(): void;
}

export function column(table: string, name: string, columnType: number, flags = 0) {
  return {
    catalog: 'def',
    schema: '',
    table,
    orgTable: table,
    name,
    orgName: name,
    characterSet: 63,
    columnLength: 20,
    columnType,
    flags,
    decimals: 0,
  };
}

function reply(conn: ServerConnection, write: () => void): void {
  conn.sequenceId = 1;
  write();
  conn.sequenceId = 0;
}

export async function startFakeMysqlServer(
  servedRow: () => ServedRow,
  answerSet: (sql: string) => FakeMysqlError | undefined,
): Promise<FakeMysqlServer> {
  const server = mysql.createServer((conn) => {
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
    client.on('stmt_prepare', (sql: string) =>
      reply(client, () => {
        const error = answerSet(sql);
        if (error) client.writeError({ code: error.errno, message: error.message });
        else client.writeOk();
      }),
    );
    client.on('query', () =>
      reply(client, () => {
        const { columns, row } = servedRow();
        client.writeColumns(columns);
        client.writeTextRow(row);
        client.writeEof();
      }),
    );
  }) as unknown as MysqlServer;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server._server.address() as AddressInfo).port, close: () => server.close() };
}
