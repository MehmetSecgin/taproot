import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SchemaCatalogStore } from '../src/store/schema-catalog.js';
import { ensureDatasourceCatalog } from '../src/core/schema-refresh.js';
import { buildSchemaContext } from '../src/core/schema-context.js';
import { runDatasourceConnectors } from '../src/core/connector-runner.js';
import {
  AFTER_SCHEMA_ERROR,
  ROUTINE,
  backdateCatalog,
  cachedTableNames,
  datasource,
  failingIntrospection,
  makeContext,
  rowsByInformationSchemaTable,
} from './helpers/schema-catalog-fixtures.js';

vi.mock(import('../src/core/connector-runner.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, runDatasourceConnectors: vi.fn<typeof actual.runDatasourceConnectors>(actual.runDatasourceConnectors) };
});

describe('eager schema catalog', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches the whole catalog once and reports the table count', async () => {
    // arrange
    const { ctx, seen } = makeContext();

    // act
    const out = await ensureDatasourceCatalog(ctx, datasource(), ROUTINE);

    // assert
    expect(out).toStrictEqual({ outcome: 'fetched', tableCount: 3 });
    expect(seen.filter((sql) => sql.includes('information_schema.columns'))).toHaveLength(1);
    expect(cachedTableNames(ctx, 'qa-orders')).toStrictEqual(['customers', 'orders', 'shipments']);
  });

  it('serves the second call from cache without re-introspecting', async () => {
    // arrange
    const { ctx, seen } = makeContext();
    await ensureDatasourceCatalog(ctx, datasource(), ROUTINE);
    const afterFirst = seen.length;

    // act
    const out = await ensureDatasourceCatalog(ctx, datasource(), ROUTINE);

    // assert
    expect(out).toStrictEqual({ outcome: 'cached', tableCount: 3 });
    expect(seen).toHaveLength(afterFirst);
  });

  it('re-introspects once the cached catalog is past its TTL', async () => {
    // arrange
    const { ctx, seen } = makeContext();
    await ensureDatasourceCatalog(ctx, datasource(), ROUTINE);
    const afterFirst = seen.length;
    backdateCatalog(ctx, 'qa-orders', 72 * 3600 * 1000);

    // act
    const out = await ensureDatasourceCatalog(ctx, datasource(), ROUTINE);

    // assert
    expect(out.outcome).toBe('fetched');
    expect(seen.length).toBeGreaterThan(afterFirst);
  });

  it('shares one in-flight fetch between concurrent callers', async () => {
    // arrange
    const { ctx, seen } = makeContext();

    // act
    const [first, second] = await Promise.all([ensureDatasourceCatalog(ctx, datasource(), ROUTINE), ensureDatasourceCatalog(ctx, datasource(), ROUTINE)]);

    // assert
    expect(first).toStrictEqual({ outcome: 'fetched', tableCount: 3 });
    expect(second).toStrictEqual(first);
    expect(seen.filter((sql) => sql.includes('information_schema.columns'))).toHaveLength(1);
  });

  it('runs the connector preflight once and every statement on the query session', async () => {
    // arrange
    const { ctx, sessions } = makeContext();
    vi.mocked(runDatasourceConnectors).mockClear();

    // act
    await ensureDatasourceCatalog(ctx, datasource('mysql', 'qa-session'), { ...ROUTINE, sessionId: 'sess-1' });

    // assert
    expect(vi.mocked(runDatasourceConnectors).mock.calls.map(([request]) => request.datasource.name)).toStrictEqual(['qa-session']);
    expect(sessions).toStrictEqual(['sess-1', 'sess-1', 'sess-1']);
  });

  it('holds a query slot for the whole fetch', async () => {
    // arrange
    const { ctx, seen } = makeContext();
    const slotEvents: string[] = [];
    const acquireQuerySlot = async (): Promise<() => void> => {
      slotEvents.push(`acquire after ${seen.length}`);
      return () => {
        slotEvents.push(`release after ${seen.length}`);
      };
    };

    // act
    await ensureDatasourceCatalog(ctx, datasource('mysql', 'qa-slot'), { ...ROUTINE, acquireQuerySlot });

    // assert
    expect(slotEvents).toStrictEqual(['acquire after 0', 'release after 3']);
  });

  it('refetches after a schema error once the catalog is older than a minute', async () => {
    // arrange
    const { ctx, seen } = makeContext();
    await ensureDatasourceCatalog(ctx, datasource(), ROUTINE);
    backdateCatalog(ctx, 'qa-orders', 2 * 60 * 1000);
    const afterFirst = seen.length;

    // act
    const out = await ensureDatasourceCatalog(ctx, datasource(), AFTER_SCHEMA_ERROR);

    // assert
    expect(out.outcome).toBe('fetched');
    expect(seen.length).toBeGreaterThan(afterFirst);
  });

  it('serves a catalog under a minute old from cache after a schema error', async () => {
    // arrange
    const { ctx, seen } = makeContext();
    await ensureDatasourceCatalog(ctx, datasource(), ROUTINE);
    const afterFirst = seen.length;

    // act
    const out = await ensureDatasourceCatalog(ctx, datasource(), AFTER_SCHEMA_ERROR);

    // assert
    expect(out).toStrictEqual({ outcome: 'cached', tableCount: 3 });
    expect(seen).toHaveLength(afterFirst);
  });

  it('reports unsupported kinds without touching the plugin', async () => {
    // arrange
    const { ctx, seen } = makeContext();

    // act
    const out = await ensureDatasourceCatalog(ctx, datasource('redis'), ROUTINE);

    // assert
    expect(out).toStrictEqual({ outcome: 'unsupported', tableCount: 0 });
    expect(seen).toStrictEqual([]);
  });

  it('never fails the query when introspection throws', async () => {
    // arrange
    const { ctx } = makeContext(failingIntrospection('connection refused'));

    // act
    const out = await ensureDatasourceCatalog(ctx, datasource('mysql', 'qa-refused'), ROUTINE);

    // assert
    expect(out.outcome).toBe('failed');
    expect(out.error).toContain('connection refused');
  });

  it('does not retry a failed fetch within the failure window, even after a schema error', async () => {
    // arrange
    const { ctx, seen } = makeContext(failingIntrospection('SELECT command denied'));
    await ensureDatasourceCatalog(ctx, datasource('mysql', 'qa-denied'), ROUTINE);
    const afterFirst = seen.length;

    // act
    const again = await ensureDatasourceCatalog(ctx, datasource('mysql', 'qa-denied'), ROUTINE);
    const afterSchemaError = await ensureDatasourceCatalog(ctx, datasource('mysql', 'qa-denied'), AFTER_SCHEMA_ERROR);

    // assert
    expect(again).toStrictEqual({ outcome: 'failed', tableCount: 0, error: 'SELECT command denied' });
    expect(afterSchemaError).toStrictEqual(again);
    expect(seen).toHaveLength(afterFirst);
  });

  it('retries a failed fetch once the failure window has passed', async () => {
    // arrange
    const { ctx, seen } = makeContext(failingIntrospection('SELECT command denied'));
    await ensureDatasourceCatalog(ctx, datasource('mysql', 'qa-denied-later'), ROUTINE);
    const afterFirst = seen.length;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 6 * 60 * 1000);

    // act
    await ensureDatasourceCatalog(ctx, datasource('mysql', 'qa-denied-later'), ROUTINE);

    // assert
    expect(seen.length).toBeGreaterThan(afterFirst);
  });

  it('keeps indexes without BTREE and non-unique defaults, and parses the partition key', async () => {
    // arrange
    const { ctx } = makeContext(rowsByInformationSchemaTable({
      columns: [
        { table_name: 'order_items', column_name: 'id' },
        { table_name: 'order_items', column_name: 'order_date' },
        { table_name: 'order_items', column_name: 'customer_id' },
      ],
      statistics: [
        { table_name: 'order_items', index_name: 'PRIMARY', seq_in_index: 1, column_name: 'id', non_unique: '0', index_type: 'BTREE' },
        { table_name: 'order_items', index_name: 'idx_order_customer', seq_in_index: 1, column_name: 'order_date', non_unique: '1', index_type: 'BTREE' },
        { table_name: 'order_items', index_name: 'idx_order_customer', seq_in_index: 2, column_name: 'customer_id', non_unique: '1', index_type: 'BTREE' },
      ],
      partitions: [{ table_name: 'order_items', partition_method: 'RANGE', partition_expression: '`order_date`' }],
    }));

    // act
    await ensureDatasourceCatalog(ctx, datasource(), ROUTINE);

    // assert
    expect(ctx.schemaCatalogStore.get('qa-orders')?.tables.order_items).toStrictEqual({
      database: 'orders',
      columns: ['id', 'order_date', 'customer_id'],
      primaryKey: ['id'],
      indexes: [
        { name: 'PRIMARY', columns: ['id'], unique: true },
        { name: 'idx_order_customer', columns: ['order_date', 'customer_id'] },
      ],
      partition: { kind: 'RANGE', expr: '`order_date`', key: 'order_date', keys: ['order_date'] },
    });
  });

  it('returns only the referenced tables plus the catalog summary', async () => {
    // arrange
    const { ctx } = makeContext();
    await ensureDatasourceCatalog(ctx, datasource(), ROUTINE);

    // act
    const context = buildSchemaContext('SELECT id FROM ORDERS', ctx.schemaCatalogStore.get('qa-orders'));

    // assert
    expect(Object.keys(context.tables)).toStrictEqual(['orders']);
    expect(context.tables.orders.columns).toContain('order_date');
    expect(context.catalog?.tables).toBe(3);
  });

  it('lists and clears cached catalogs', async () => {
    // arrange
    const { ctx } = makeContext();
    await ensureDatasourceCatalog(ctx, datasource(), ROUTINE);

    // act
    const listed = ctx.schemaCatalogStore.list();
    const cleared = ctx.schemaCatalogStore.clear();

    // assert
    expect(listed.map(({ datasource: name, tables }) => ({ name, tables }))).toStrictEqual([{ name: 'qa-orders', tables: 3 }]);
    expect(cleared).toBe(1);
    expect(ctx.schemaCatalogStore.get('qa-orders')).toBeUndefined();
  });

  it('reads a corrupt cached catalog as missing and replaces it on the next save', () => {
    // arrange
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-catalog-corrupt-'));
    const store = new SchemaCatalogStore(dir);
    fs.writeFileSync(path.join(dir, 'qa-orders.json'), '{"datasource":"qa-orders"');

    // act
    const before = store.get('qa-orders');
    const listedBefore = store.list();
    store.save('qa-orders', {});

    // assert
    expect(before).toBeUndefined();
    expect(listedBefore).toStrictEqual([]);
    expect(store.get('qa-orders')).toMatchObject({ datasource: 'qa-orders', tables: {} });
  });
});
