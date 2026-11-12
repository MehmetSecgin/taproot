import mysql from 'mysql2';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeAllMysqlPools } from '../src/plugins-builtins/_shared/db-conn.js';
import { column, leaseFakeMysqlConnection, startFakeMysqlServer, type FakeMysqlError, type FakeMysqlServer } from './helpers/fake-mysql-server.js';

const READ_ONLY_SESSION_SQL = 'SET SESSION transaction_read_only = 1';

let servedTimestamp = '';
let readOnlySessionUnsupported = false;
let executionLimitUnsupported = false;
const receivedSets: string[] = [];
let server: FakeMysqlServer;

function answerSet(sql: string): FakeMysqlError | undefined {
  receivedSets.push(sql);
  if (readOnlySessionUnsupported && sql === READ_ONLY_SESSION_SQL) {
    return { errno: 1235, message: 'function READ ONLY has only noop implementation' };
  }
  if (executionLimitUnsupported && sql.startsWith('SET SESSION max_execution_time')) {
    return { errno: 1193, message: "Unknown system variable 'max_execution_time'" };
  }
  return undefined;
}

beforeAll(async () => {
  vi.stubEnv('TZ', 'Asia/Tokyo');
  server = await startFakeMysqlServer(
    () => ({
      columns: [column('orders', 'created_at', mysql.Types.TIMESTAMP)],
      row: [servedTimestamp],
    }),
    answerSet,
  );
});

beforeEach(() => {
  receivedSets.length = 0;
  readOnlySessionUnsupported = false;
  executionLimitUnsupported = false;
});

afterEach(closeAllMysqlPools);

afterAll(() => {
  server?.close();
  vi.unstubAllEnvs();
});

async function selectCreatedAt(sessionTimeZone: string): Promise<unknown> {
  const { conn, release } = await leaseFakeMysqlConnection(server, { timeZone: sessionTimeZone });
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

describe('MySQL read lease session', () => {
  it('runs the read in a read-only session', async () => {
    // arrange
    servedTimestamp = '2026-11-07 10:42:00';

    // act
    await selectCreatedAt('+00:00');

    // assert
    expect(receivedSets).toContain(READ_ONLY_SESSION_SQL);
  });

  it('leaves a write lease out of the read-only session', async () => {
    // act
    const { release } = await leaseFakeMysqlConnection(server, { capability: 'executeMutate' });
    await release();

    // assert
    expect(receivedSets.filter((sql) => sql.includes('transaction_read_only'))).toEqual([]);
  });

  it('still reads from a server that cannot enforce a read-only session', async () => {
    // arrange
    servedTimestamp = '2026-11-07 10:42:00';
    readOnlySessionUnsupported = true;

    // act
    const createdAt = await selectCreatedAt('+00:00');

    // assert
    expect((createdAt as Date).toISOString()).toBe('2026-11-07T10:42:00.000Z');
  });
});

describe('MySQL server-side execution limit', () => {
  it('sets max_execution_time from the timeout only when the pooled connection had another value', async () => {
    // act
    for (const timeoutMs of [5_000, 5_000, 7_000]) {
      const { release } = await leaseFakeMysqlConnection(server, { sessionId: 'execution-limit', timeoutMs });
      await release();
    }

    // assert
    expect(receivedSets.filter((sql) => sql.includes('max_execution_time'))).toEqual([
      'SET SESSION max_execution_time = 5000',
      'SET SESSION max_execution_time = 7000',
    ]);
    expect(receivedSets.filter((sql) => sql.startsWith('SET time_zone'))).toHaveLength(1);
  });

  it('still reads from a server without max_execution_time', async () => {
    // arrange
    servedTimestamp = '2026-11-07 10:42:00';
    executionLimitUnsupported = true;

    // act
    const { conn, release } = await leaseFakeMysqlConnection(server, { timeoutMs: 5_000 });
    const [rows] = await conn.query('SELECT created_at FROM orders').finally(release);

    // assert
    expect(rows).toHaveLength(1);
  });
});
