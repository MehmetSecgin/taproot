import { describe, expect, it } from 'vitest';
import { enforcePartitionPredicate } from '../src/core/safety.js';
import { buildSchemaContext } from '../src/core/schema-context.js';
import type { SchemaCatalog } from '../src/store/schema-catalog.js';
import type { DatasourceKind, DatasourceProfile } from '../src/types/datasource.js';
import type { SchemaContext } from '../src/types/schema-context.js';

const NO_CATALOG: SchemaCatalog | undefined = undefined;

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

function datasource(kind: DatasourceKind = 'mysql'): DatasourceProfile {
  return {
    name: 'orders',
    kind,
    connection: {},
    credentialRef: 'orders',
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    updatedAt: '',
  };
}

const mysql = datasource();

describe('partition predicate gate', () => {
  it('throws for RANGE partitions without the partition predicate', () => {
    expect(() =>
      enforcePartitionPredicate({
        datasource: mysql,
        sql: 'SELECT id FROM order_items WHERE customer_id = 1 LIMIT 1',
        schemaContext: context({ kind: 'RANGE', expr: 'order_date', key: 'order_date', keys: ['order_date'] }),
      }),
    ).toThrow(/MISSING_PARTITION_PREDICATE/u);
  });

  it('passes when WHERE contains the partition predicate', () => {
    expect(
      enforcePartitionPredicate({
        datasource: mysql,
        sql: "SELECT id FROM order_items WHERE order_date BETWEEN '2026-05-01' AND '2026-05-02'",
        schemaContext: context({ kind: 'RANGE', expr: 'order_date', key: 'order_date', keys: ['order_date'] }),
      }),
    ).toStrictEqual([]);
  });

  it('passes when JOIN ON contains the partition predicate', () => {
    expect(
      enforcePartitionPredicate({
        datasource: mysql,
        sql: 'SELECT e.id FROM order_items e JOIN events ev ON ev.order_date = e.order_date AND ev.id = e.id',
        schemaContext: context({ kind: 'RANGE', expr: 'order_date', key: 'order_date', keys: ['order_date'] }),
      }),
    ).toStrictEqual([]);
  });

  it('requires all composite RANGE COLUMNS keys', () => {
    expect(() =>
      enforcePartitionPredicate({
        datasource: mysql,
        sql: "SELECT id FROM order_items WHERE order_date = '2026-05-02'",
        schemaContext: context({ kind: 'RANGE', expr: 'order_date, region_id', keys: ['order_date', 'region_id'] }),
      }),
    ).toThrow(/region_id/u);
  });

  it('allows explicit bypass with warning', () => {
    expect(
      enforcePartitionPredicate({
        datasource: mysql,
        sql: 'SELECT id FROM order_items WHERE customer_id = 1',
        schemaContext: context({ kind: 'LIST', expr: 'order_date', key: 'order_date', keys: ['order_date'] }),
        allowPartitionScan: true,
      }),
    ).toContain('partition_scan_bypassed');
  });

  it('warns but does not fail for HASH and KEY partitions', () => {
    expect(
      enforcePartitionPredicate({
        datasource: mysql,
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
    ]) {
      expect(enforcePartitionPredicate({ datasource: mysql, sql, schemaContext })).toStrictEqual([]);
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
      expect(enforcePartitionPredicate({ datasource: mysql, sql, schemaContext })).toStrictEqual([]);
    }
  });

  it('gates EXPLAIN ANALYZE by the statement it runs', () => {
    const schemaContext = context({ kind: 'RANGE', expr: 'order_date', key: 'order_date', keys: ['order_date'] });
    expect(() =>
      enforcePartitionPredicate({ datasource: mysql, sql: 'EXPLAIN ANALYZE SELECT id FROM order_items WHERE customer_id = 1', schemaContext }),
    ).toThrow(/MISSING_PARTITION_PREDICATE/u);
    expect(
      enforcePartitionPredicate({
        datasource: mysql,
        sql: "EXPLAIN ANALYZE SELECT id FROM order_items WHERE order_date = '2026-01-01'",
        schemaContext,
      }),
    ).toStrictEqual([]);
  });

  it('gates EXPLAIN ANALYZE behind a leading comment', () => {
    const { tables } = context({ kind: 'RANGE', expr: 'order_date', key: 'order_date', keys: ['order_date'] });
    const sql = '/* audit */ EXPLAIN ANALYZE SELECT id FROM order_items WHERE customer_id = 1';
    const schemaContext = buildSchemaContext(sql, { datasource: 'orders', fetchedAt: new Date().toISOString(), tables });
    expect(() => enforcePartitionPredicate({ datasource: mysql, sql, schemaContext })).toThrow(/MISSING_PARTITION_PREDICATE/u);
  });

  it('matches an upper-case WHERE column to a lower-case partition key', () => {
    expect(
      enforcePartitionPredicate({
        datasource: mysql,
        sql: "SELECT id FROM ORDER_ITEMS O WHERE O.ORDER_DATE > '2026-05-01'",
        schemaContext: context({ kind: 'RANGE', expr: 'order_date', key: 'order_date', keys: ['order_date'] }),
      }),
    ).toStrictEqual([]);
  });

  it('matches a lower-case WHERE column to an upper-case partition key', () => {
    expect(
      enforcePartitionPredicate({
        datasource: mysql,
        sql: "SELECT id FROM order_items WHERE order_date > '2026-05-01'",
        schemaContext: context({ kind: 'RANGE', expr: 'ORDER_DATE', key: 'ORDER_DATE', keys: ['ORDER_DATE'] }),
      }),
    ).toStrictEqual([]);
  });

  it('still throws for a plain SELECT on a RANGE partitioned table', () => {
    const schemaContext = context({ kind: 'RANGE', expr: 'order_date', key: 'order_date', keys: ['order_date'] });
    expect(() => enforcePartitionPredicate({ datasource: mysql, sql: 'SELECT * FROM order_items', schemaContext })).toThrow(
      /MISSING_PARTITION_PREDICATE/u,
    );
  });
});

describe('partition gate skip warning', () => {
  it('warns when the datasource has no cached catalog yet or its fetch failed', () => {
    const sql = 'SELECT id FROM order_items WHERE customer_id = 1';
    expect(enforcePartitionPredicate({ datasource: mysql, sql, schemaContext: buildSchemaContext(sql, NO_CATALOG) })).toStrictEqual([
      'partition_gate_skipped',
    ]);
  });

  it('warns when the parser cannot read the SQL', () => {
    expect(
      enforcePartitionPredicate({
        datasource: mysql,
        sql: 'SELECT id FROM order_items AS OF TIMESTAMP NOW() - INTERVAL 5 SECOND WHERE customer_id = 1',
        schemaContext: context({ kind: 'RANGE', expr: 'order_date', key: 'order_date', keys: ['order_date'] }),
      }),
    ).toStrictEqual(['partition_gate_skipped']);
  });

  it('stays quiet for a metadata query without a catalog', () => {
    const sql = 'SHOW CREATE TABLE order_items';
    expect(enforcePartitionPredicate({ datasource: mysql, sql, schemaContext: buildSchemaContext(sql, NO_CATALOG) })).toStrictEqual([]);
  });

  it('stays quiet for Redis and gRPC datasources', () => {
    for (const [kind, sql] of [
      ['redis', 'GET profile:1'],
      ['grpc', 'ProfileService/GetProfile {"id": 1}'],
    ] as const) {
      expect(enforcePartitionPredicate({ datasource: datasource(kind), sql, schemaContext: { tables: {} } })).toStrictEqual([]);
    }
  });
});
