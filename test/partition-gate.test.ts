import { afterEach, describe, expect, it } from 'vitest';
import { collectRangeWarnings, enforcePartitionPredicate } from '../src/core/safety.js';
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
        dialect: 'mysql',
      }),
    ).toThrow(/MISSING_PARTITION_PREDICATE/);
  });

  it('passes when WHERE contains the partition predicate', () => {
    expect(
      enforcePartitionPredicate({
        sql: "SELECT id FROM order_items WHERE order_date BETWEEN '2026-05-01' AND '2026-05-02'",
        schemaContext: context({ kind: 'RANGE', expr: 'order_date', key: 'order_date', keys: ['order_date'] }),
        dialect: 'mysql',
      }),
    ).toEqual([]);
  });

  it('passes when JOIN ON contains the partition predicate', () => {
    expect(
      enforcePartitionPredicate({
        sql: 'SELECT e.id FROM order_items e JOIN events ev ON ev.order_date = e.order_date AND ev.id = e.id',
        schemaContext: context({ kind: 'RANGE', expr: 'order_date', key: 'order_date', keys: ['order_date'] }),
        dialect: 'mysql',
      }),
    ).toEqual([]);
  });

  it('requires all composite RANGE COLUMNS keys', () => {
    expect(() =>
      enforcePartitionPredicate({
        sql: "SELECT id FROM order_items WHERE order_date = '2026-05-02'",
        schemaContext: context({ kind: 'RANGE', expr: 'order_date, region_id', keys: ['order_date', 'region_id'] }),
        dialect: 'mysql',
      }),
    ).toThrow(/region_id/);
  });

  it('allows explicit bypass with warning', () => {
    expect(
      enforcePartitionPredicate({
        sql: 'SELECT id FROM order_items WHERE customer_id = 1',
        schemaContext: context({ kind: 'LIST', expr: 'order_date', key: 'order_date', keys: ['order_date'] }),
        dialect: 'mysql',
        allowPartitionScan: true,
      }),
    ).toContain('partition_scan_bypassed');
  });

  it('warns but does not fail for HASH and KEY partitions', () => {
    expect(
      enforcePartitionPredicate({
        sql: 'SELECT id FROM order_items WHERE customer_id = 1',
        schemaContext: context({ kind: 'HASH', expr: 'order_date', key: 'order_date', keys: ['order_date'] }),
        dialect: 'mysql',
      })[0],
    ).toContain('partition_pruning_not_enforced');
  });

  it('sees the partition predicate in postgres-only syntax', () => {
    expect(
      enforcePartitionPredicate({
        sql: "SELECT id FROM order_items WHERE order_date BETWEEN '2026-05-01' AND '2026-05-02' AND note ILIKE '%rush%'",
        schemaContext: context({ kind: 'RANGE', expr: 'order_date', key: 'order_date', keys: ['order_date'] }),
        dialect: 'postgres',
      }),
    ).toEqual([]);
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
      expect(enforcePartitionPredicate({ sql, schemaContext, dialect: 'mysql' })).toEqual([]);
    }
  });

  it('bypasses SHOW COLUMNS, FIELDS, INDEXES, KEYS and CREATE VIEW', () => {
    const schemaContext = context({ kind: 'RANGE', expr: 'order_date', key: 'order_date', keys: ['order_date'] });
    for (const sql of [
      'SHOW COLUMNS FROM order_items',
      'show   columns from order_items',
      'SHOW FIELDS FROM order_items',
      'SHOW FULL FIELDS FROM order_items',
      'SHOW INDEXES FROM order_items',
      'SHOW KEYS FROM order_items',
      'SHOW CREATE VIEW order_items',
    ]) {
      expect(enforcePartitionPredicate({ sql, schemaContext, dialect: 'mysql' })).toEqual([]);
    }
  });

  it('still throws for a plain SELECT on a RANGE partitioned table', () => {
    const schemaContext = context({ kind: 'RANGE', expr: 'order_date', key: 'order_date', keys: ['order_date'] });
    expect(() => enforcePartitionPredicate({ sql: 'SELECT * FROM order_items', schemaContext, dialect: 'mysql' })).toThrow(
      /MISSING_PARTITION_PREDICATE/,
    );
  });
});

describe('range guard', () => {
  const partitioned = () => context({ kind: 'RANGE', expr: 'order_date', key: 'order_date', keys: ['order_date'] });

  it('stays quiet for a narrow bounded range', () => {
    expect(
      collectRangeWarnings({
        sql: "SELECT id FROM order_items WHERE order_date >= '2026-05-01' AND order_date < '2026-05-08'",
        schemaContext: partitioned(),
        dialect: 'mysql',
      }),
    ).toEqual([]);
  });

  it('stays quiet for single-day equality', () => {
    expect(
      collectRangeWarnings({
        sql: "SELECT id FROM order_items WHERE order_date = '2026-05-01'",
        schemaContext: partitioned(),
        dialect: 'mysql',
      }),
    ).toEqual([]);
  });

  it('warns when the partition key has no upper bound', () => {
    expect(
      collectRangeWarnings({
        sql: "SELECT id FROM order_items WHERE order_date >= '2020-01-01'",
        schemaContext: partitioned(),
        dialect: 'mysql',
      }),
    ).toEqual(['unbounded_range:order_items.order_date']);
  });

  it('warns when the bounded range exceeds the max', () => {
    expect(
      collectRangeWarnings({
        sql: "SELECT id FROM order_items WHERE order_date BETWEEN '2025-01-01' AND '2026-01-01'",
        schemaContext: partitioned(),
        dialect: 'mysql',
        maxRangeDays: 90,
      }),
    ).toEqual(['wide_range:order_items.order_date:actual=365:max=90']);
  });

  it('respects a larger explicit max', () => {
    expect(
      collectRangeWarnings({
        sql: "SELECT id FROM order_items WHERE order_date BETWEEN '2025-01-01' AND '2026-01-01'",
        schemaContext: partitioned(),
        dialect: 'mysql',
        maxRangeDays: 400,
      }),
    ).toEqual([]);
  });

  it('warns as unverified when the predicate uses no date literal', () => {
    expect(
      collectRangeWarnings({
        sql: 'SELECT id FROM order_items WHERE order_date >= CURDATE() - INTERVAL 7 DAY',
        schemaContext: partitioned(),
        dialect: 'mysql',
      }),
    ).toEqual(['range_unverified:order_items.order_date']);
  });

  it('ignores date literals bound to other columns', () => {
    expect(
      collectRangeWarnings({
        sql: "SELECT id FROM order_items WHERE order_date BETWEEN '2026-05-01' AND '2026-05-08' AND created_at >= '2020-01-01'",
        schemaContext: partitioned(),
        dialect: 'mysql',
        maxRangeDays: 90,
      }),
    ).toEqual([]);
  });

  it('measures the span of an IN list on the partition key', () => {
    expect(
      collectRangeWarnings({
        sql: "SELECT id FROM order_items WHERE order_date IN ('2025-01-01', '2026-01-01')",
        schemaContext: partitioned(),
        dialect: 'mysql',
        maxRangeDays: 90,
      }),
    ).toEqual(['wide_range:order_items.order_date:actual=365:max=90']);
  });

  it('ignores tables that are not range partitioned', () => {
    expect(
      collectRangeWarnings({
        sql: "SELECT id FROM order_items WHERE order_date >= '2020-01-01'",
        schemaContext: context(),
        dialect: 'mysql',
      }),
    ).toEqual([]);
  });

  it('measures the span for postgres-only syntax', () => {
    expect(
      collectRangeWarnings({
        sql: "SELECT id FROM order_items WHERE order_date BETWEEN '2025-01-01' AND '2026-01-01' AND note ILIKE '%rush%'",
        schemaContext: partitioned(),
        dialect: 'postgres',
        maxRangeDays: 90,
      }),
    ).toEqual(['wide_range:order_items.order_date:actual=365:max=90']);
  });

  it('ignores metadata queries', () => {
    expect(
      collectRangeWarnings({ sql: 'SHOW CREATE TABLE order_items', schemaContext: partitioned(), dialect: 'mysql' }),
    ).toEqual([]);
  });
});
