import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { enforceConfinedTables, enforceDatabaseConfinement } from '../src/core/database-confinement.js';
import { executeQuery, silentQueryReport } from '../src/core/execute-query.js';
import { queryDatasourceResolver } from '../src/core/resolve-query-datasource.js';
import { rpcCall } from '../src/daemon/client.js';
import type { DatasourceProfile, QueryResult } from '../src/types/core.js';
import { startLocalDaemon } from './helpers/daemon.js';
import { fakePlugin } from './helpers/fake-plugin.js';
import { contextWith, queryRequest, restoreQueryEnv, setupQueryState } from './helpers/query-state.js';

afterEach(restoreQueryEnv);

function profile(overrides: { database?: string; confineToDatabase?: boolean; kind?: string } = {}): DatasourceProfile {
  const { database = 'shop', confineToDatabase = true, kind = 'mysql' } = overrides;
  return {
    name: 'qa-shop',
    kind,
    connection: { database },
    credentialRef: 'qa',
    policy: { allowRead: true, allowMutate: true, allowedCapabilities: ['executeRead', 'executeMutate'], confineToDatabase },
    updatedAt: '',
  };
}

function refusal(sql: string, datasource = profile()): { message: string; details?: unknown } | undefined {
  try {
    enforceDatabaseConfinement({ sql, datasource });
    return undefined;
  } catch (error) {
    return { message: (error as Error).message, details: (error as Error & { details?: unknown }).details };
  }
}

describe('database confinement of a statement', () => {
  it.each([
    'SELECT * FROM orders',
    'SELECT * FROM shop.orders',
    'SELECT * FROM `shop`.`orders` o JOIN customers c ON c.id = o.customer_id',
    'WITH recent AS (SELECT id FROM shop.orders) SELECT * FROM recent',
    'SELECT id FROM orders UNION SELECT id FROM shop.refunds',
    'SELECT * FROM (SELECT id FROM orders) d WHERE d.id IN (SELECT order_id FROM refunds)',
    'SELECT * FROM orders o LEFT JOIN (shop.refunds r CROSS JOIN items i) ON 1',
    'SELECT shop.order_total(id) FROM orders',
    'SELECT o.id, shop.orders.status FROM orders o JOIN shop.orders ON 1',
    'UPDATE shop.orders SET status = 1 WHERE id = 1',
    'INSERT INTO orders (id) SELECT id FROM shop.refunds',
    'EXPLAIN SELECT * FROM shop.orders',
    "EXPLAIN ANALYZE FORMAT = 'brief' SELECT * FROM orders",
    'DESCRIBE orders',
    'DESC shop.orders status',
    'SHOW TABLES',
    "SHOW FULL TABLES FROM shop LIKE 'ord%'",
    'SHOW TABLE STATUS IN `shop`',
    'SHOW FULL COLUMNS FROM orders',
    'SHOW COLUMNS FROM orders FROM shop',
    'SHOW INDEX FROM shop.orders',
    'SHOW CREATE TABLE shop.orders',
    'SELECT * FROM orders;',
    "-- daily check\nSELECT * FROM orders /* agent */ WHERE note = 'other.t'",
    'SELECT /*+ MAX_EXECUTION_TIME(1000) */ * FROM orders',
  ])('runs %s, which stays in the profile database', (sql) => {
    expect(refusal(sql)).toBeUndefined();
  });

  it.each([
    ['SELECT * FROM orders o JOIN other.customers c ON c.id = o.customer_id', 'other'],
    ['SELECT * FROM orders WHERE id IN (SELECT order_id FROM other.refunds)', 'other'],
    ['WITH r AS (SELECT * FROM other.refunds) SELECT * FROM r', 'other'],
    ['SELECT id FROM orders UNION SELECT id FROM other.refunds', 'other'],
    ['SELECT * FROM (SELECT * FROM other.refunds) d', 'other'],
    ['SELECT * FROM orders LEFT JOIN (other.refunds CROSS JOIN items) ON 1', 'other'],
    ['SELECT other.refunds.id FROM orders', 'other'],
    ['SELECT other.leak(id) FROM orders', 'other'],
    ['INSERT INTO orders SELECT * FROM other.refunds', 'other'],
    ['DELETE FROM other.refunds', 'other'],
    ['EXPLAIN SELECT * FROM other.refunds', 'other'],
    ['DESCRIBE other.refunds', 'other'],
    ['SHOW TABLES FROM other', 'other'],
    ['SHOW CREATE TABLE other.refunds', 'other'],
    ['SHOW COLUMNS FROM refunds FROM other', 'other'],
    ['SHOW COLUMNS FROM other.refunds', 'other'],
    ['SHOW INDEX FROM other.refunds', 'other'],
    ['SELECT * FROM information_schema.tables', 'information_schema'],
    ['SELECT user FROM mysql.user', 'mysql'],
    ['SELECT * FROM performance_schema.threads', 'performance_schema'],
    ['SHOW DATABASES', 'information_schema'],
  ])('refuses %s, which reaches schema %s', (sql, reached) => {
    expect(refusal(sql)).toEqual({
      message: `DATABASE_CONFINED: datasource 'qa-shop' is confined to schema 'shop', and '${reached}' is another schema. Name tables of 'shop' bare or as shop.<table>.`,
      details: { reached },
    });
  });

  it.each([
    'SELECT * FROM orders AS OF TIMESTAMP NOW()',
    'SHOW PROCESSLIST',
    "SHOW VARIABLES LIKE 'time_zone'",
    'TABLE orders',
    'CALL shop.refresh()',
  ])('refuses %s, which it cannot analyse', (sql) => {
    expect(refusal(sql)?.message).toMatch(/^DATABASE_CONFINED: datasource 'qa-shop' is confined to schema 'shop', and TapRoot cannot tell which schemas this statement reaches: it is not one SELECT/);
  });

  it('runs anything with confinement off', () => {
    expect(refusal('SELECT * FROM other.refunds', profile({ confineToDatabase: false }))).toBeUndefined();
    expect(refusal('SHOW PROCESSLIST', profile({ confineToDatabase: false }))).toBeUndefined();
  });

  it('refuses a confined profile that names no database', () => {
    expect(refusal('SELECT 1', profile({ database: '' }))?.message).toBe(
      "MISCONFIGURED_DATASOURCE: datasource 'qa-shop' is confined to its database but names none. Set one with datasource add --database <schema>.",
    );
  });
});

describe('database confinement against parser bypasses', () => {
  it.each([
    'SELECT 1 /*! FROM other.refunds */',
    'SELECT 1 /*!50000 FROM other.refunds */',
    'SELECT 1 /*T![clustered_index] FROM other.refunds */',
  ])('refuses the executable comment in %s, which the server runs and the parser skips', (sql) => {
    expect(refusal(sql)?.message).toContain('it holds an executable comment');
  });

  it('refuses --1, which the server reads as minus minus one and the parser as a comment', () => {
    expect(refusal('SELECT 1 --1 FROM other.refunds')?.message).toContain("it holds '--' without an ASCII space after it");
  });

  it('refuses -- before a non-ASCII space, which the server reads as code', () => {
    expect(refusal('SELECT 1 --\u00a0x FROM other.refunds')?.message).toContain("it holds '--' without an ASCII space after it");
  });

  it('refuses a backslash, which ends a string early on a server running NO_BACKSLASH_ESCAPES', () => {
    expect(refusal("SELECT 'a\\' , other.refunds.id FROM other.refunds -- '")?.message).toContain('it holds a backslash');
  });

  it('reads past a block comment the way the server does, where a nested opener does not nest', () => {
    expect(refusal('SELECT * FROM orders /* /* */ , other.refunds')?.details).toEqual({ reached: 'other' });
  });

  it.each([
    ['SELECT * FROM `other`.refunds', 'other'],
    ['SELECT * FROM `sh``op`.orders', 'sh`op'],
    ['SELECT * FROM OTHER.refunds', 'OTHER'],
    ['SELECT * FROM SHOP.orders', 'SHOP'],
    ['SELECT * FROM `shop `.orders', 'shop '],
  ])('compares the exact schema spelling of %s', (sql, reached) => {
    expect(refusal(sql)?.details).toEqual({ reached });
  });

  it.each([
    'USE other',
    'SELECT 1; USE other',
    "SET @@session.sql_mode = 'ANSI_QUOTES'",
    'PREPARE s FROM @q',
  ])('refuses %s, which changes the default schema or the session', (sql) => {
    expect(refusal(sql)?.message).toContain('TapRoot cannot tell which schemas this statement reaches');
  });

  it.each([
    'SHOW TABLES WHERE Tables_in_shop IN (SELECT name FROM other.refunds)',
    'SHOW COLUMNS FROM orders WHERE Field IN (SELECT name FROM other.refunds)',
    'EXPLAIN FOR CONNECTION 7',
  ])('refuses %s, whose WHERE or target it does not read', (sql) => {
    expect(refusal(sql)?.message).toContain('TapRoot cannot tell which schemas this statement reaches');
  });
});

describe('database confinement of a schema read', () => {
  it('refuses a table qualified with another schema', () => {
    expect(() => enforceConfinedTables(profile(), ['orders', 'other.refunds'])).toThrow(
      "DATABASE_CONFINED: datasource 'qa-shop' is confined to schema 'shop', and 'other' is another schema.",
    );
  });

  it('lets bare tables and tables of the profile database through', () => {
    expect(() => enforceConfinedTables(profile(), ['orders', 'shop.refunds'])).not.toThrow();
  });

  it('refuses a confined profile that names no database even with no table asked for', () => {
    expect(() => enforceConfinedTables(profile({ database: '' }), [])).toThrow(/^MISCONFIGURED_DATASOURCE/);
  });

  it('lets any table through with confinement off', () => {
    expect(() => enforceConfinedTables(profile({ confineToDatabase: false }), ['other.refunds'])).not.toThrow();
  });
});

describe('database confinement where queries run', () => {
  const confinedProfile = {
    kind: 'mysql',
    connection: { host: '127.0.0.1', port: 1, database: 'shop' },
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead' as const], confineToDatabase: true },
  };

  it('refuses a cross-schema query before it reaches the plugin', async () => {
    // arrange
    await setupQueryState(confinedProfile);
    const sent: string[] = [];
    const plugin = fakePlugin({ kind: 'mysql' });
    const inner = plugin.execute!;
    plugin.execute = async (request, creds): Promise<QueryResult> => {
      sent.push(request.query);
      return inner(request, creds);
    };
    const ctx = contextWith(plugin);

    // act
    const outcome = await executeQuery(queryRequest({ query: 'SELECT * FROM other.refunds' }), {
      ctx,
      report: silentQueryReport,
      signal: undefined,
      acquireQuerySlot: undefined,
      resolveDatasource: queryDatasourceResolver(undefined),
    });

    // assert
    expect(outcome).toMatchObject({ ok: false, code: 'DATABASE_CONFINED', details: { reached: 'other' } });
    expect(sent.filter((query) => query.includes('other'))).toEqual([]);
  });

  it('serves schema.read from the catalog of the profile database and refuses another schema', async () => {
    // arrange
    const stateRoot = await setupQueryState(confinedProfile);
    const socketPath = path.join(stateRoot, 'run', 'taprootd-confined.sock');
    const plugin = fakePlugin({ kind: 'mysql', columns: ['table_name', 'column_name'], rows: [['orders', 'id']] });
    const daemon = await startLocalDaemon({ stateRoot, socketPath, plugins: [plugin] });

    try {
      // act
      const own = await rpcCall({ socketPath, method: 'schema.read', params: { datasource: 'qa-fake', tables: ['orders'] } });
      const other = await rpcCall({ socketPath, method: 'schema.read', params: { datasource: 'qa-fake', tables: ['other.refunds'] } });

      // assert
      expect(own.data).toEqual({ tables: { orders: { columns: ['id'] } } });
      expect(other).toMatchObject({ ok: false, error: { code: 'DATABASE_CONFINED' } });
    } finally {
      await daemon.stop();
    }
  });
});
