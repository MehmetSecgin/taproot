import { afterEach, describe, expect, it } from 'vitest';
import { enforcePartitionPredicate } from '../src/core/safety.js';
import type { SchemaContext } from '../src/types/core.js';

const previousAllow = process.env.TAPROOT_ALLOW_PARTITION_SCAN;

afterEach(() => {
  process.env.TAPROOT_ALLOW_PARTITION_SCAN = previousAllow;
});

function context(partition?: SchemaContext['tables'][string]['partition']): SchemaContext {
  return {
    tables: {
      order_items: {
        database: 'order_service',
        columns: ['id', 'customer_id', 'order_date', 'region_id'],
        primaryKey: ['id'],
        indexes: [{ name: 'idx_order_customer', columns: ['order_date', 'customer_id'] }],
        partition,
        lastSeenAt: new Date().toISOString(),
      },
    },
  };
}

describe('partition predicate gate', () => {
  it('throws for RANGE partitions without the partition predicate', () => {
    expect(() =>
      enforcePartitionPredicate({
        sql: 'SELECT id FROM order_items WHERE customer_id = 1 LIMIT 1',
        schemaContext: context({ kind: 'RANGE', expr: 'order_date', key: 'order_date', keys: ['order_date'] }),
      }),
    ).toThrow(/MISSING_PARTITION_PREDICATE/);
  });

  it('passes when WHERE contains the partition predicate', () => {
    expect(
      enforcePartitionPredicate({
        sql: "SELECT id FROM order_items WHERE order_date BETWEEN '2026-05-01' AND '2026-05-02'",
        schemaContext: context({ kind: 'RANGE', expr: 'order_date', key: 'order_date', keys: ['order_date'] }),
      }),
    ).toEqual([]);
  });

  it('passes when JOIN ON contains the partition predicate', () => {
    expect(
      enforcePartitionPredicate({
        sql: 'SELECT e.id FROM order_items e JOIN events ev ON ev.order_date = e.order_date AND ev.id = e.id',
        schemaContext: context({ kind: 'RANGE', expr: 'order_date', key: 'order_date', keys: ['order_date'] }),
      }),
    ).toEqual([]);
  });

  it('requires all composite RANGE COLUMNS keys', () => {
    expect(() =>
      enforcePartitionPredicate({
        sql: "SELECT id FROM order_items WHERE order_date = '2026-05-02'",
        schemaContext: context({ kind: 'RANGE', expr: 'order_date, region_id', keys: ['order_date', 'region_id'] }),
      }),
    ).toThrow(/region_id/);
  });

  it('allows explicit bypass with warning', () => {
    expect(
      enforcePartitionPredicate({
        sql: 'SELECT id FROM order_items WHERE customer_id = 1',
        schemaContext: context({ kind: 'LIST', expr: 'order_date', key: 'order_date', keys: ['order_date'] }),
        allowPartitionScan: true,
      }),
    ).toContain('partition_scan_bypassed');
  });

  it('warns but does not fail for HASH and KEY partitions', () => {
    expect(
      enforcePartitionPredicate({
        sql: 'SELECT id FROM order_items WHERE customer_id = 1',
        schemaContext: context({ kind: 'HASH', expr: 'order_date', key: 'order_date', keys: ['order_date'] }),
      })[0],
    ).toContain('partition_pruning_not_enforced');
  });

  it('bypasses metadata and diagnostic commands', () => {
    const schemaContext = context({ kind: 'RANGE', expr: 'order_date', key: 'order_date', keys: ['order_date'] });
    for (const sql of [
      'SHOW CREATE TABLE order_items',
      'SHOW TABLES',
      'SHOW FULL COLUMNS FROM order_items',
      'SHOW INDEX FROM order_items',
      'DESC order_items',
      'DESCRIBE order_items',
      'EXPLAIN SELECT id FROM order_items WHERE customer_id = 1',
      'EXPLAIN ANALYZE SELECT id FROM order_items WHERE customer_id = 1',
    ]) {
      expect(enforcePartitionPredicate({ sql, schemaContext })).toEqual([]);
    }
  });
});
