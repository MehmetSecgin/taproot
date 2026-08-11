import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildSchemaContext, collectPredicateColumns, collectReferencedTables } from '../src/core/schema-context.js';
import { LearningStore } from '../src/store/learning.js';

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-schema-context-'));
  const store = new LearningStore(dir);
  const datasource = {
    name: 'qa-orders',
    kind: 'mysql',
    env: 'qa',
    service: 'orders',
    connection: { database: 'orders', target: 'orders-db' },
    credentialRef: 'qa:orders',
    connectors: [],
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    updatedAt: new Date().toISOString(),
    confidence: 1,
  };
  store.saveSchemaRefresh({
    datasource: datasource as any,
    source: 'refreshed-metadata',
    tables: [
      {
        table: 'orders',
        columns: ['id', 'customer_id', 'order_date'],
        primaryKey: ['id'],
        indexes: [{ name: 'idx_order_customer', columns: ['order_date', 'customer_id'] }],
        partition: { kind: 'RANGE', expr: 'order_date', key: 'order_date', keys: ['order_date'] },
      },
      {
        table: 'customers',
        columns: ['id'],
        primaryKey: ['id'],
        indexes: [{ name: 'PRIMARY', columns: ['id'], unique: true }],
      },
    ],
    joins: [],
  });
  return store;
}

describe('schema context', () => {
  it('returns metadata for referenced joined tables', () => {
    const store = makeStore();
    const out = buildSchemaContext(
      'SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.order_date = "2026-05-02"',
      { service: 'orders', dialect: 'mysql' },
      store,
    );

    expect(Object.keys(out.tables).sort()).toEqual(['customers', 'orders']);
    expect(out.tables.orders.indexes[0].columns).toEqual(['order_date', 'customer_id']);
    expect(out.tables.orders.partition?.key).toBe('order_date');
  });

  it('prefers complete refreshed metadata over older observed qualified rows', () => {
    const store = makeStore();
    store.saveSuccess({
      datasource: {
        name: 'qa-orders',
        kind: 'mysql',
        env: 'qa',
        service: 'orders',
        connection: { database: 'orders', target: 'orders-db' },
        credentialRef: 'qa:orders',
        policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
        updatedAt: new Date().toISOString(),
        confidence: 1,
      } as any,
      sql: 'SHOW CREATE TABLE orders.orders',
    });

    const out = buildSchemaContext('SELECT id FROM orders', { service: 'orders', dialect: 'mysql' }, store);

    expect(out.tables.orders.columns).toContain('order_date');
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
    const store = makeStore();

    const out = buildSchemaContext(
      "SELECT id FROM orders WHERE customer_note ILIKE '%rush%'",
      { service: 'orders', dialect: 'postgres' },
      store,
    );

    expect(Object.keys(out.tables)).toEqual(['orders']);
  });

  it('returns empty context for unparseable SQL', () => {
    const store = makeStore();
    expect(buildSchemaContext('SELECT FROM WHERE', { service: 'orders', dialect: 'mysql' }, store)).toEqual({ tables: {} });
  });
});
