import mysql from 'mysql2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { queryTimeoutError } from '../src/core/query-timeout.js';
import { closeAllMysqlPools } from '../src/plugins-builtins/_shared/mysql-connection-lease.js';
import { mysqlPlugin } from '../src/plugins-builtins/mysql/index.js';
import type { QueryResult } from '../src/types/plugin.js';
import { column, startFakeMysqlServer } from './helpers/fake-mysql-server.js';
import { answerWithoutError, executeOf, messageOf, mysqlProfilesDatasource, startServerForTest } from './helpers/mysql-row-cap-support.js';

const POOL_SIZE = 4;

type HeldServer = {
  port: number;
  heldAnswers: (() => void)[];
  servedSelects: string[];
};

async function startHoldingServer(): Promise<HeldServer> {
  const heldAnswers: (() => void)[] = [];
  const servedSelects: string[] = [];
  const server = await startServerForTest(async () =>
    startFakeMysqlServer(async (sql) => {
      if (sql.startsWith('SELECT')) {
        servedSelects.push(sql);
        await new Promise<void>((resolve) => {
          heldAnswers.push(resolve);
        });
      }
      return { columns: [column('profiles', 'ok', mysql.Types.LONG)], row: ['1'] };
    }, answerWithoutError),
  );
  return { port: server.port, heldAnswers, servedSelects };
}

async function select(port: number, query: string, signal?: AbortSignal): Promise<QueryResult> {
  return executeOf(mysqlPlugin)(
    { datasource: mysqlProfilesDatasource(port), query, capability: 'executeRead', sessionTimeZone: '+00:00', signal },
    { user: 'reader', password: '', __sessionId: 'lease-deadline' },
  );
}

function answerNextSelect(held: HeldServer): void {
  const answer = held.heldAnswers.shift();
  if (answer === undefined) {
    throw new Error('no select is waiting for an answer');
  }
  answer();
}

function answerAllSelects(held: HeldServer): void {
  for (const answer of held.heldAnswers.splice(0)) {
    answer();
  }
}

describe('mysql lease deadline', () => {
  afterEach(closeAllMysqlPools);

  it('hands a connection leased after the deadline back to the pool without running the query', async () => {
    // arrange
    const held = await startHoldingServer();
    const holders = Array.from({ length: POOL_SIZE }, async (_, holder) => select(held.port, `SELECT ${holder} AS holder`));
    await vi.waitFor(() => {
      expect(held.heldAnswers).toHaveLength(POOL_SIZE);
    });
    const deadline = new AbortController();
    const late = select(held.port, 'SELECT 1 AS late', deadline.signal);
    deadline.abort(queryTimeoutError(50));

    // act
    answerNextSelect(held);
    await holders[0];
    const lateOutcome = await late.catch(messageOf);
    const next = select(held.port, 'SELECT 1 AS next');
    await vi.waitFor(() => {
      expect(held.heldAnswers).toHaveLength(POOL_SIZE);
    });
    answerAllSelects(held);
    await Promise.all([next, ...holders]);

    // assert
    expect(lateOutcome).toBe(queryTimeoutError(50).message);
    expect(held.servedSelects).not.toContain('SELECT 1 AS late');
    expect(held.servedSelects).toContain('SELECT 1 AS next');
  });
});
