import { Server } from 'node:net';
import { promisify } from 'node:util';
import mysql from 'mysql2';
import { leaseMysqlConnection } from '../../src/plugins-builtins/_shared/mysql-connection-lease.js';
import type { MysqlLeaseRequest } from '../../src/plugins-builtins/_shared/mysql-connection-lease.js';
import { createNoop } from './noop.js';

type ServerConnection = {
  sequenceId: number;
  stream: { on: (event: 'close', listener: () => void) => void };
  on: (event: string, listener: (sql: string) => unknown) => void;
  serverHandshake: (args: Record<string, unknown>) => void;
  writeOk: () => void;
  writeError: (error: { code: number; message: string }) => void;
  writeColumns: (columns: unknown[]) => void;
  writeTextRow: (row: unknown[]) => void;
  writeEof: () => void;
};

type MysqlServer = {
  listen: (port: number, host: string, onListening: () => void) => void;
  close: () => void;
};

type NetServer = Server & { allowHalfOpen: boolean };

type MysqlColumnDefinition = {
  catalog: string;
  schema: string;
  table: string;
  orgTable: string;
  name: string;
  orgName: string;
  characterSet: number;
  columnLength: number;
  columnType: number;
  flags: number;
  decimals: number;
};

type ServedRow = {
  columns: unknown[];
  row: unknown[];
};

export type FakeMysqlError = {
  errno: number;
  message: string;
};

export type FakeMysqlServer = {
  port: number;
  openConnections: () => Promise<number>;
  close: () => void;
};

export function column(table: string, name: string, columnType: number): MysqlColumnDefinition {
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
    flags: 0,
    decimals: 0,
  };
}

function isServerConnection(value: unknown): value is ServerConnection {
  return typeof value === 'object' && value !== null && 'serverHandshake' in value;
}

function isMysqlServer(value: unknown): value is MysqlServer {
  return typeof value === 'object' && value !== null && 'listen' in value;
}

function isNetServer(value: unknown): value is NetServer {
  return value instanceof Server;
}

function netServerOf(server: MysqlServer): NetServer {
  const candidate: unknown = Reflect.get(server, '_server');
  if (!isNetServer(candidate)) {
    throw new TypeError('mysql2 server does not expose its net server');
  }
  return candidate;
}

function portOf(server: Server): number {
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new TypeError('fake mysql server is not listening on a TCP port');
  }
  return address.port;
}

async function countConnections(server: Server): Promise<number> {
  const getConnections = promisify((receiveCount: (error: Error | null, count: number) => void): void => {
    server.getConnections(receiveCount);
  });
  return getConnections();
}

function reply(conn: ServerConnection, write: () => void): void {
  conn.sequenceId = 1;
  write();
  conn.sequenceId = 0;
}

function handshakeFor(client: ServerConnection): Record<string, unknown> {
  return {
    protocolVersion: 10,
    serverVersion: '8.0.0',
    connectionId: 1,
    statusFlags: 2,
    characterSet: 8,
    capabilityFlags: 0xFF_FF_FF,
    authCallback: (_params: unknown, accept: () => void) => {
      accept();
      client.sequenceId = 0;
    },
  };
}

async function acceptClients(serve: (client: ServerConnection) => void, allowHalfOpen: boolean): Promise<FakeMysqlServer> {
  const created: unknown = mysql.createServer((connection) => {
    const client: unknown = connection;
    if (!isServerConnection(client)) {
      throw new TypeError('mysql2 connection lacks serverHandshake');
    }
    client.on('error', createNoop());
    client.serverHandshake(handshakeFor(client));
    serve(client);
  });
  if (!isMysqlServer(created)) {
    throw new TypeError('mysql2 createServer did not return a server');
  }
  const netServer = netServerOf(created);
  netServer.allowHalfOpen = allowHalfOpen;
  await new Promise<void>((resolve) => {
    created.listen(0, '127.0.0.1', resolve);
  });
  return {
    port: portOf(netServer),
    openConnections: async () => countConnections(netServer),
    close: () => {
      created.close();
    },
  };
}

export async function startFakeMysqlServer(
  servedRow: (sql: string) => ServedRow | Promise<ServedRow>,
  answerSet: (sql: string) => FakeMysqlError | undefined,
): Promise<FakeMysqlServer> {
  return acceptClients((client) => {
    client.on('stmt_prepare', (sql: string) => {
      reply(client, () => {
        const error = answerSet(sql);
        if (error === undefined) {
          client.writeOk();
        } else {
          client.writeError({ code: error.errno, message: error.message });
        }
      });
    });
    client.on('query', async (sql: string) => {
      const { columns, row } = await servedRow(sql);
      reply(client, () => {
        client.writeColumns(columns);
        client.writeTextRow(row);
        client.writeEof();
      });
    });
  }, false);
}

export async function startEndlessMysqlServer({ columns, row }: ServedRow): Promise<FakeMysqlServer> {
  return acceptClients((client) => {
    client.on('stmt_prepare', () => {
      reply(client, () => {
        client.writeOk();
      });
    });
    client.on('query', (sql: string) => {
      if (sql.startsWith('SET ')) {
        reply(client, () => {
          client.writeOk();
        });
        return;
      }
      client.sequenceId = 1;
      client.writeColumns(columns);
      const sending = setInterval(() => {
        client.writeTextRow(row);
      }, 1);
      client.stream.on('close', () => {
        clearInterval(sending);
      });
      client.on('error', () => {
        clearInterval(sending);
      });
    });
  }, true);
}

export async function leaseFakeMysqlConnection(
  server: FakeMysqlServer,
  { timeZone = '+00:00', ...lease }: Partial<MysqlLeaseRequest> & { timeZone?: string } = {},
): ReturnType<typeof leaseMysqlConnection> {
  return leaseMysqlConnection({ host: '127.0.0.1', port: server.port, user: 'reader', password: '' }, timeZone, {
    capability: 'executeRead',
    sessionId: undefined,
    signal: undefined,
    timeoutMs: undefined,
    ...lease,
  });
}
