import mysql from 'mysql2';
import type { RowDataPacket } from 'mysql2/promise';
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { closeAllMysqlPools } from '../src/plugins-builtins/_shared/mysql-connection-lease.js';
import { column, leaseFakeMysqlConnection, startFakeMysqlServer } from './helpers/fake-mysql-server.js';
import type { FakeMysqlError, FakeMysqlServer } from './helpers/fake-mysql-server.js';
import { answerWithoutError, startServerForTest } from './helpers/mysql-row-cap-support.js';

const READ_ONLY_SESSION_SQL = 'SET SESSION transaction_read_only = 1';
const INSTANT_NAMED_BY_SERVED_TIMESTAMP = new Date('2026-11-07T10:42:00.000Z');
const ER_NOT_SUPPORTED_YET = 1235;
const ER_UNKNOWN_SYSTEM_VARIABLE = 1193;

type ServerBehavior = {
  servedTimestamp: string;
  readOnlySessionUnsupported: boolean;
  executionLimitUnsupported: boolean;
};

type RunningServer = {
  server: FakeMysqlServer;
  receivedSets: string[];
};

const defaultBehavior: ServerBehavior = {
  servedTimestamp: '2026-11-07 10:42:00',
  readOnlySessionUnsupported: false,
  executionLimitUnsupported: false,
};

async function startServer(overrides: Partial<ServerBehavior> = {}): Promise<RunningServer> {
  const behavior = { ...defaultBehavior, ...overrides };
  const receivedSets: string[] = [];
  vi.stubEnv('TZ', 'Asia/Tokyo');
  onTestFinished(() => {
    vi.unstubAllEnvs();
  });
  const answerSet = (sql: string): FakeMysqlError | undefined => {
    receivedSets.push(sql);
    if (behavior.readOnlySessionUnsupported && sql === READ_ONLY_SESSION_SQL) {
      return { errno: ER_NOT_SUPPORTED_YET, message: 'function READ ONLY has only noop implementation' };
    }
    if (behavior.executionLimitUnsupported && sql.startsWith('SET SESSION max_execution_time')) {
      return { errno: ER_UNKNOWN_SYSTEM_VARIABLE, message: "Unknown system variable 'max_execution_time'" };
    }
    return answerWithoutError();
  };
  const server = await startServerForTest(async () =>
    startFakeMysqlServer(
      () => ({
        columns: [column('orders', 'created_at', mysql.Types.TIMESTAMP)],
        row: [behavior.servedTimestamp],
      }),
      answerSet,
    ),
  );
  return { server, receivedSets };
}

async function selectCreatedAt(server: FakeMysqlServer, sessionTimeZone: string): Promise<unknown> {
  const { conn, release } = await leaseFakeMysqlConnection(server, { timeZone: sessionTimeZone });
  try {
    const [rows] = await conn.query<RowDataPacket[]>('SELECT created_at FROM orders');
    const createdAt: unknown = rows[0]?.created_at;
    return createdAt;
  } finally {
    await release();
  }
}

async function countOrdersWithTimeout(server: FakeMysqlServer, timeoutMs: number): Promise<number> {
  const { conn, release } = await leaseFakeMysqlConnection(server, { timeoutMs });
  try {
    const [rows] = await conn.query<RowDataPacket[]>('SELECT created_at FROM orders');
    return rows.length;
  } finally {
    await release();
  }
}

describe('mysql session time zone', () => {
  afterEach(closeAllMysqlPools);

  it.each([
    ['+00:00', '2026-11-07 10:42:00'],
    ['+05:30', '2026-11-07 16:12:00'],
  ])('reads a TIMESTAMP the server renders in %s as the instant it names', async (sessionTimeZone, rendered) => {
    // arrange
    const { server } = await startServer({ servedTimestamp: rendered });

    // act
    const createdAt = await selectCreatedAt(server, sessionTimeZone);

    // assert
    expect(createdAt).toStrictEqual(INSTANT_NAMED_BY_SERVED_TIMESTAMP);
  });

  it('keeps the server wall clock for a named session zone', async () => {
    // arrange
    const { server } = await startServer({ servedTimestamp: '2026-11-07 11:42:00' });

    // act
    const createdAt = await selectCreatedAt(server, 'Europe/Berlin');

    // assert
    expect(createdAt).toBe('2026-11-07 11:42:00');
  });
});

describe('mysql read lease session', () => {
  afterEach(closeAllMysqlPools);

  it('runs the read in a read-only session', async () => {
    // arrange
    const { server, receivedSets } = await startServer();

    // act
    await selectCreatedAt(server, '+00:00');

    // assert
    expect(receivedSets).toContain(READ_ONLY_SESSION_SQL);
  });

  it('leaves a write lease out of the read-only session', async () => {
    // arrange
    const { server, receivedSets } = await startServer();

    // act
    const { release } = await leaseFakeMysqlConnection(server, { capability: 'executeMutate' });
    await release();

    // assert
    expect(receivedSets.filter((sql) => sql.includes('transaction_read_only'))).toStrictEqual([]);
  });

  it('still reads from a server that cannot enforce a read-only session', async () => {
    // arrange
    const { server } = await startServer({ readOnlySessionUnsupported: true });

    // act
    const createdAt = await selectCreatedAt(server, '+00:00');

    // assert
    expect(createdAt).toStrictEqual(INSTANT_NAMED_BY_SERVED_TIMESTAMP);
  });
});

describe('mysql server-side execution limit', () => {
  afterEach(closeAllMysqlPools);

  it('sets max_execution_time from the timeout only when the pooled connection had another value', async () => {
    // arrange
    const { server, receivedSets } = await startServer();

    // act
    for (const timeoutMs of [5000, 5000, 7000]) {
      const { release } = await leaseFakeMysqlConnection(server, { sessionId: 'execution-limit', timeoutMs });
      await release();
    }

    // assert
    expect(receivedSets.filter((sql) => sql.includes('max_execution_time'))).toStrictEqual([
      'SET SESSION max_execution_time = 5000',
      'SET SESSION max_execution_time = 7000',
    ]);
    expect(receivedSets.filter((sql) => sql.startsWith('SET time_zone'))).toHaveLength(1);
  });

  it('still reads from a server without max_execution_time', async () => {
    // arrange
    const { server } = await startServer({ executionLimitUnsupported: true });

    // act
    const rowCount = await countOrdersWithTimeout(server, 5000);

    // assert
    expect(rowCount).toBe(1);
  });
});
