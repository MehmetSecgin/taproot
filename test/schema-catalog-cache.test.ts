import { describe, expect, it } from 'vitest';
import { cachedSchemaCatalog, readSchema } from '../src/core/schema-read.js';
import { ensureDatasourceCatalog } from '../src/core/schema-refresh.js';
import type { QuerySlot } from '../src/core/schema-refresh.js';
import {
  ORDERS_COLUMNS,
  ROUTINE,
  backdateCatalog,
  cachedTableNames,
  columnRowsOnly,
  datasource,
  failingIntrospection,
  immediateQuerySlot,
  makeContext,
} from './helpers/schema-catalog-fixtures.js';

const NO_QUERY_SLOT: QuerySlot | undefined = undefined;

describe('cache-first schema catalog', () => {
  it('waits for the first fetch when nothing is cached', async () => {
    // arrange
    const { ctx } = makeContext();

    // act
    const catalog = await cachedSchemaCatalog(ctx, datasource('mysql', 'qa-first-read'), immediateQuerySlot);

    // assert
    expect(Object.keys(catalog.tables)).toStrictEqual(['customers', 'orders', 'shipments']);
  });

  it('shares one fetch between callers that find nothing cached', async () => {
    // arrange
    const { ctx, seen } = makeContext();

    // act
    await Promise.all([1, 2, 3].map(async () => cachedSchemaCatalog(ctx, datasource('mysql', 'qa-shared'), immediateQuerySlot)));

    // assert
    expect(seen.filter((sql) => sql.includes('information_schema.columns'))).toHaveLength(1);
  });

  it('answers from an expired catalog at once and refreshes it in the background', async () => {
    // arrange
    let columns = ORDERS_COLUMNS;
    const { ctx } = makeContext(columnRowsOnly(() => columns));
    await cachedSchemaCatalog(ctx, datasource('mysql', 'qa-expired'), immediateQuerySlot);
    backdateCatalog(ctx, 'qa-expired', 72 * 3600 * 1000);
    columns = [{ table_name: 'invoices', column_name: 'id' }];

    // act
    const served = await cachedSchemaCatalog(ctx, datasource('mysql', 'qa-expired'), immediateQuerySlot);
    await ensureDatasourceCatalog(ctx, datasource('mysql', 'qa-expired'), ROUTINE);

    // assert
    expect(Object.keys(served.tables)).toStrictEqual(['customers', 'orders', 'shipments']);
    expect(cachedTableNames(ctx, 'qa-expired')).toStrictEqual(['invoices']);
  });

  it('names the fetch error when nothing is cached', async () => {
    // arrange
    const { ctx } = makeContext(failingIntrospection('ECONNREFUSED'));

    // act
    const read = cachedSchemaCatalog(ctx, datasource('mysql', 'qa-unreachable'), immediateQuerySlot);

    // assert
    await expect(read).rejects.toThrow("CONNECTIVITY: could not read the schema of 'qa-unreachable': ECONNREFUSED.");
  });

  it('refuses a datasource kind that has no schema', async () => {
    // arrange
    const { ctx } = makeContext();

    // act
    const read = cachedSchemaCatalog(ctx, datasource('redis', 'qa-cache'), immediateQuerySlot);

    // assert
    await expect(read).rejects.toThrow("BAD_INPUT: 'qa-cache' is a redis datasource; only SQL datasources have a schema.");
  });
});

describe('schema read', () => {
  it('finds a table created after the catalog was cached', async () => {
    // arrange
    let columns = ORDERS_COLUMNS;
    const { ctx } = makeContext(columnRowsOnly(() => columns));
    await readSchema(ctx, { datasource: datasource('mysql', 'qa-grown'), tables: [], acquireQuerySlot: NO_QUERY_SLOT });
    backdateCatalog(ctx, 'qa-grown', 2 * 60 * 1000);
    columns = [...ORDERS_COLUMNS, { table_name: 'invoices', column_name: 'id' }];

    // act
    const schema = await readSchema(ctx, { datasource: datasource('mysql', 'qa-grown'), tables: ['invoices'], acquireQuerySlot: NO_QUERY_SLOT });

    // assert
    expect(schema.tables).toStrictEqual({ invoices: { columns: ['id'] } });
  });
});
