import { describe, expect, it } from 'vitest';
import { buildSchemaContext, collectPredicateColumns, collectReferencedTables, suggestSchemaNames } from '../src/core/schema-context.js';
import type { SchemaCatalog } from '../src/store/schema-catalog.js';

function makeCatalog(): SchemaCatalog {
  return {
    datasource: 'qa-orders',
    fetchedAt: new Date().toISOString(),
    tables: {
      orders: {
        database: 'orders',
        columns: ['id', 'customer_id', 'order_date'],
        primaryKey: ['id'],
        indexes: [{ name: 'idx_order_customer', columns: ['order_date', 'customer_id'] }],
        partition: { kind: 'RANGE', expr: 'order_date', key: 'order_date', keys: ['order_date'] },
      },
      customers: {
        database: 'orders',
        columns: ['id'],
        primaryKey: ['id'],
        indexes: [{ name: 'PRIMARY', columns: ['id'], unique: true }],
      },
    },
  };
}

describe('schema context', () => {
  it('returns metadata for referenced joined tables', () => {
    const out = buildSchemaContext(
      'SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.order_date = "2026-05-02"',
      'mysql',
      makeCatalog(),
    );

    expect(Object.keys(out.tables).sort()).toEqual(['customers', 'orders']);
    expect(out.tables.orders.indexes[0].columns).toEqual(['order_date', 'customer_id']);
    expect(out.tables.orders.partition?.key).toBe('order_date');
  });

  it('walks CTEs and subqueries without returning the CTE alias as a physical table', () => {
    const refs = collectReferencedTables(`
      WITH recent AS (SELECT id FROM orders WHERE order_date = '2026-05-02')
      SELECT * FROM recent WHERE id IN (SELECT customer_id FROM customers)
    `, 'mysql');

    expect(refs.sort()).toEqual(['customers', 'orders']);
  });

  it('resolves aliases for predicate columns', () => {
    const refs = collectPredicateColumns(
      'SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.order_date = "2026-05-02"',
      'mysql',
    );
    expect(refs.byTable.get('orders')?.has('order_date')).toBe(true);
    expect(refs.byTable.get('customers')?.has('id')).toBe(true);
  });

  it('resolves aliases for postgres predicate columns', () => {
    const refs = collectPredicateColumns(
      "SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.order_date = '2026-05-02'",
      'postgres',
    );

    expect(refs.byTable.get('orders')?.has('order_date')).toBe(true);
    expect(refs.byTable.get('customers')?.has('id')).toBe(true);
  });

  it('resolves referenced tables for postgres-only syntax', () => {

    const out = buildSchemaContext(
      "SELECT id FROM orders WHERE customer_note ILIKE '%rush%'",
      'postgres',
      makeCatalog(),
    );

    expect(Object.keys(out.tables)).toEqual(['orders']);
  });

  it('returns empty context for unparseable SQL', () => {
    expect(buildSchemaContext('SELECT FROM WHERE', 'mysql', makeCatalog()).tables).toEqual({});
    expect(buildSchemaContext('SELECT id FROM orders', 'mysql', undefined)).toEqual({ tables: {} });
  });
});

describe('suggestSchemaNames', () => {
  it('suggests the closest column of a referenced table for a MySQL error', () => {
    const context = buildSchemaContext('SELECT customer_ident FROM orders', 'mysql', makeCatalog());
    expect(suggestSchemaNames('UNKNOWN_COLUMN', "Unknown column 'customer_ident' in 'field list'", context, makeCatalog())[0]).toBe('orders.customer_id');
  });

  it('reads the column name from a Postgres error', () => {
    const context = buildSchemaContext('SELECT o.order_day FROM orders o', 'postgres', makeCatalog());
    expect(suggestSchemaNames('UNKNOWN_COLUMN', 'column o.order_day does not exist', context, makeCatalog())[0]).toBe('orders.order_date');
  });

  it('suggests catalog tables for a missing table, ignoring the database prefix', () => {
    const context = buildSchemaContext('SELECT id FROM customer', 'mysql', makeCatalog());
    expect(suggestSchemaNames('UNKNOWN_TABLE', "Table 'orders.customer' doesn't exist", context, makeCatalog())[0]).toBe('customers');
  });

  it('suggests nothing without a cached catalog', () => {
    expect(suggestSchemaNames('UNKNOWN_TABLE', "Table 'orders.customer' doesn't exist", { tables: {} }, undefined)).toEqual([]);
  });
});
