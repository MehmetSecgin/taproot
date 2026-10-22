import { describe, expect, it } from 'vitest';
import { buildSchemaContext, collectPredicateColumns, collectReferencedTables } from '../src/core/schema-context.js';
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
