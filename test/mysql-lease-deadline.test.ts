import mysql from 'mysql2';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { queryTimeoutError } from '../src/core/query-timeout.js';
import { closeAllMysqlPools } from '../src/plugins-builtins/_shared/db-conn.js';
import { mysqlPlugin } from '../src/plugins-builtins/mysql/index.js';
import type { DatasourceProfile, QueryResult } from '../src/types/core.js';
import { column, startFakeMysqlServer, type FakeMysqlServer } from './helpers/fake-mysql-server.js';

const POOL_SIZE = 4;
const answerSelect: Array<() => void> = [];
const servedSelects: string[] = [];
let server: FakeMysqlServer;

beforeAll(async () => {
  server = await startFakeMysqlServer(async (sql) => {
    if (sql.startsWith('SELECT')) {
      servedSelects.push(sql);
      await new Promise<void>((resolve) => answerSelect.push(resolve));
    }
    return { columns: [column('profiles', 'ok', mysql.Types.LONG)], row: ['1'] };
  }, () => undefined);
});

afterAll(async () => {
  await closeAllMysqlPools();
  server?.close();
});

function select(query: string, signal: AbortSignal | undefined): Promise<QueryResult> {
  const datasource = {
    name: 'qa-profiles',
    kind: 'mysql',
    connection: { host: '127.0.0.1', port: server.port, database: 'profiles' },
  } as DatasourceProfile;
  return mysqlPlugin.execute!(
    { datasource, query, capability: 'executeRead', sessionTimeZone: '+00:00', signal },
    { user: 'reader', password: '', __sessionId: 'lease-deadline' },
  );
}

describe('MySQL lease deadline', () => {
  it('hands a connection leased after the deadline back to the pool without running the query', async () => {
    // arrange
    const holders = Array.from({ length: POOL_SIZE }, (_, i) => select(`SELECT ${i} AS holder`, undefined));
    await vi.waitFor(() => expect(answerSelect).toHaveLength(POOL_SIZE));
    const deadline = new AbortController();
    const late = select('SELECT 1 AS late', deadline.signal);
    deadline.abort(queryTimeoutError(50));

    // act
    answerSelect.shift()!();
    await holders[0];
    const lateOutcome = await late.catch((error: Error) => error.message);
    const next = select('SELECT 1 AS next', undefined);
    await vi.waitFor(() => expect(answerSelect).toHaveLength(POOL_SIZE));
    answerSelect.splice(0).forEach((answer) => answer());
    await Promise.all([next, ...holders]);

    // assert
    expect(lateOutcome).toBe(queryTimeoutError(50).message);
    expect(servedSelects).not.toContain('SELECT 1 AS late');
    expect(servedSelects).toContain('SELECT 1 AS next');
  });
});
