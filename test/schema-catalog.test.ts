import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PluginRegistry } from '../src/plugins/registry.js';
import { SchemaCatalogStore } from '../src/store/schema-catalog.js';
import { ensureDatasourceCatalog } from '../src/core/schema-refresh.js';
import { buildSchemaContext } from '../src/core/schema-context.js';
import type { AppContext } from '../src/core/app.js';

type Rows = Array<Record<string, unknown>>;

const ORDERS_COLUMNS: Rows = [
  { table_name: 'orders', column_name: 'id' },
  { table_name: 'orders', column_name: 'order_date' },
  { table_name: 'customers', column_name: 'id' },
  { table_name: 'shipments', column_name: 'id' },
];

function makeContext(rowsFor: (sql: string) => Rows = (sql) => (sql.includes('information_schema.columns') ? ORDERS_COLUMNS : [])) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-catalog-'));
  const seen: string[] = [];
  const registry = new PluginRegistry();
  registry.register({
    manifest: { name: 'mysql', version: '0.1.0', kind: 'executor', capabilities: ['executeRead'] },
    async execute(request) {
      seen.push(request.query);
      const rows = rowsFor(request.query);
      return {
        datasource: request.datasource.name,
        plugin: 'mysql',
        capability: request.capability,
        query: { native: request.query },
        result: { columns: Object.keys(rows[0] || {}), rows },
        timings: { startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1 },
        warnings: [],
        classification: 'success',
      };
    },
  });
  const ctx = {
    paths: { cacheDir: path.join(root, 'cache') },
    credentialStore: { get: async () => ({ user: 'reader', password: 'secret' }) },
    schemaCatalogStore: new SchemaCatalogStore(path.join(root, 'cache', 'schema')),
    pluginRegistry: registry,
  } as unknown as AppContext;
  return { ctx, seen };
}

function datasource(kind = 'mysql') {
  return {
    name: 'qa-orders',
    kind,
    env: 'qa',
    service: 'orders',
    connection: { host: '127.0.0.1', port: 3306, database: 'orders' },
    credentialRef: 'qa:orders',
    connectors: [],
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    updatedAt: new Date().toISOString(),
    confidence: 1,
  } as any;
}

describe('eager schema catalog', () => {
  it('fetches the whole catalog once and reports the table count', async () => {
    // arrange
    const { ctx, seen } = makeContext();

    // act
    const out = await ensureDatasourceCatalog(ctx, datasource());

    // assert
    expect(out).toEqual({ outcome: 'fetched', tableCount: 3 });
    expect(seen.some((sql) => sql.includes('information_schema.columns'))).toBe(true);
    expect(Object.keys(ctx.schemaCatalogStore.get('qa-orders')!.tables)).toEqual(['customers', 'orders', 'shipments']);
  });

  it('serves the second call from cache without re-introspecting', async () => {
    // arrange
    const { ctx, seen } = makeContext();
    await ensureDatasourceCatalog(ctx, datasource());
    const afterFirst = seen.length;

    // act
    const out = await ensureDatasourceCatalog(ctx, datasource());

    // assert
    expect(out).toEqual({ outcome: 'cached', tableCount: 3 });
    expect(seen.length).toBe(afterFirst);
  });

  it('re-introspects once the cached catalog is past its TTL', async () => {
    // arrange
    const { ctx, seen } = makeContext();
    await ensureDatasourceCatalog(ctx, datasource());
    const afterFirst = seen.length;
    const catalogFile = path.join(ctx.paths.cacheDir, 'schema', 'qa-orders.json');
    const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    catalog.fetchedAt = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    fs.writeFileSync(catalogFile, JSON.stringify(catalog));

    // act
    const out = await ensureDatasourceCatalog(ctx, datasource());

    // assert
    expect(out.outcome).toBe('fetched');
    expect(seen.length).toBeGreaterThan(afterFirst);
  });

  it('reports unsupported kinds without touching the plugin', async () => {
    // arrange
    const { ctx, seen } = makeContext();

    // act
    const out = await ensureDatasourceCatalog(ctx, datasource('redis'));

    // assert
    expect(out).toEqual({ outcome: 'unsupported', tableCount: 0 });
    expect(seen).toEqual([]);
  });

  it('never fails the query when introspection throws', async () => {
    // arrange
    const { ctx } = makeContext(() => {
      throw new Error('connection refused');
    });

    // act
    const out = await ensureDatasourceCatalog(ctx, datasource());

    // assert
    expect(out.outcome).toBe('failed');
    expect(out.error).toContain('connection refused');
  });

  it('keeps indexes without BTREE and non-unique defaults, and parses the partition key', async () => {
    // arrange
    const { ctx } = makeContext((sql) => {
      if (sql.includes('information_schema.columns')) {
        return [
          { table_name: 'order_items', column_name: 'id' },
          { table_name: 'order_items', column_name: 'order_date' },
          { table_name: 'order_items', column_name: 'customer_id' },
        ];
      }
      if (sql.includes('information_schema.statistics')) {
        return [
          { table_name: 'order_items', index_name: 'PRIMARY', seq_in_index: 1, column_name: 'id', non_unique: '0', index_type: 'BTREE' },
          { table_name: 'order_items', index_name: 'idx_order_customer', seq_in_index: 1, column_name: 'order_date', non_unique: '1', index_type: 'BTREE' },
          { table_name: 'order_items', index_name: 'idx_order_customer', seq_in_index: 2, column_name: 'customer_id', non_unique: '1', index_type: 'BTREE' },
        ];
      }
      if (sql.includes('information_schema.partitions')) {
        return [{ table_name: 'order_items', partition_method: 'RANGE', partition_expression: '`order_date`' }];
      }
      return [];
    });

    // act
    await ensureDatasourceCatalog(ctx, datasource());

    // assert
    expect(ctx.schemaCatalogStore.get('qa-orders')!.tables.order_items).toEqual({
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
    await ensureDatasourceCatalog(ctx, datasource());

    // act
    const context = buildSchemaContext('SELECT id FROM ORDERS', 'mysql', ctx.schemaCatalogStore.get('qa-orders'));

    // assert
    expect(Object.keys(context.tables)).toEqual(['orders']);
    expect(context.tables.orders.columns).toContain('order_date');
    expect(context.catalog?.tables).toBe(3);
  });

  it('lists and clears cached catalogs', async () => {
    // arrange
    const { ctx } = makeContext();
    await ensureDatasourceCatalog(ctx, datasource());

    // act
    const listed = ctx.schemaCatalogStore.list();
    const cleared = ctx.schemaCatalogStore.clear();

    // assert
    expect(listed).toEqual([{ datasource: 'qa-orders', fetchedAt: expect.any(String), tables: 3 }]);
    expect(cleared).toBe(1);
    expect(ctx.schemaCatalogStore.get('qa-orders')).toBeUndefined();
  });
});
