import { describe, expect, it } from 'vitest';
import { collectRangeWarnings } from '../src/core/query-policy.js';
import type { SchemaContext } from '../src/types/schema-context.js';

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
    catalog: { tables: 1, fetchedAt: '2026-05-01T00:00:00Z' },
  };
}

function rangePartitioned(): SchemaContext {
  return context({ kind: 'RANGE', expr: 'order_date', key: 'order_date', keys: ['order_date'] });
}

describe('range guard', () => {
  it('stays quiet for a narrow bounded range', () => {
    expect(
      collectRangeWarnings({
        sql: "SELECT id FROM order_items WHERE order_date >= '2026-05-01' AND order_date < '2026-05-08'",
        schemaContext: rangePartitioned(),
      }),
    ).toStrictEqual([]);
  });

  it('stays quiet for single-day equality', () => {
    expect(
      collectRangeWarnings({
        sql: "SELECT id FROM order_items WHERE order_date = '2026-05-01'",
        schemaContext: rangePartitioned(),
      }),
    ).toStrictEqual([]);
  });

  it('warns when the partition key has no upper bound', () => {
    expect(
      collectRangeWarnings({
        sql: "SELECT id FROM order_items WHERE order_date >= '2020-01-01'",
        schemaContext: rangePartitioned(),
      }),
    ).toStrictEqual(['unbounded_range:order_items.order_date']);
  });

  it('warns when the bounded range exceeds the max', () => {
    expect(
      collectRangeWarnings({
        sql: "SELECT id FROM order_items WHERE order_date BETWEEN '2025-01-01' AND '2026-01-01'",
        schemaContext: rangePartitioned(),
        maxRangeDays: 90,
      }),
    ).toStrictEqual(['wide_range:order_items.order_date:actual=365:max=90']);
  });

  it('respects a larger explicit max', () => {
    expect(
      collectRangeWarnings({
        sql: "SELECT id FROM order_items WHERE order_date BETWEEN '2025-01-01' AND '2026-01-01'",
        schemaContext: rangePartitioned(),
        maxRangeDays: 400,
      }),
    ).toStrictEqual([]);
  });

  it('warns as unverified when the predicate uses no date literal', () => {
    expect(
      collectRangeWarnings({
        sql: 'SELECT id FROM order_items WHERE order_date >= CURDATE() - INTERVAL 7 DAY',
        schemaContext: rangePartitioned(),
      }),
    ).toStrictEqual(['range_unverified:order_items.order_date']);
  });

  it('ignores date literals bound to other columns', () => {
    expect(
      collectRangeWarnings({
        sql: "SELECT id FROM order_items WHERE order_date BETWEEN '2026-05-01' AND '2026-05-08' AND created_at >= '2020-01-01'",
        schemaContext: rangePartitioned(),
        maxRangeDays: 90,
      }),
    ).toStrictEqual([]);
  });

  it('measures the span of an IN list on the partition key', () => {
    expect(
      collectRangeWarnings({
        sql: "SELECT id FROM order_items WHERE order_date IN ('2025-01-01', '2026-01-01')",
        schemaContext: rangePartitioned(),
        maxRangeDays: 90,
      }),
    ).toStrictEqual(['wide_range:order_items.order_date:actual=365:max=90']);
  });

  it('checks the range of an upper-case WHERE column', () => {
    expect(
      collectRangeWarnings({
        sql: "SELECT id FROM ORDER_ITEMS WHERE ORDER_DATE >= '2020-01-01'",
        schemaContext: rangePartitioned(),
      }),
    ).toStrictEqual(['unbounded_range:order_items.order_date']);
  });

  it('ignores tables that are not range partitioned', () => {
    expect(
      collectRangeWarnings({
        sql: "SELECT id FROM order_items WHERE order_date >= '2020-01-01'",
        schemaContext: context(),
      }),
    ).toStrictEqual([]);
  });

  it('ignores metadata queries', () => {
    expect(
      collectRangeWarnings({ sql: 'SHOW CREATE TABLE order_items', schemaContext: rangePartitioned() }),
    ).toStrictEqual([]);
  });
});
