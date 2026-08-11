import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractQueryShape } from '../src/core/schema-learning.js';
import { LearningStore } from '../src/store/learning.js';
import type { DatasourceProfile, QueryResult } from '../src/types/core.js';

function mkDatasource(): DatasourceProfile {
  return {
    name: 'qa-orders',
    kind: 'mysql',
    env: 'qa',
    service: 'orders',
    tags: [],
    connection: { host: '127.0.0.1', port: 3306, database: 'orders' },
    credentialRef: 'qa:orders',
    connectors: [],
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    updatedAt: new Date().toISOString(),
    confidence: 0.9,
  };
}

function mkResult(sql: string): QueryResult {
  return {
    runId: 'run-1',
    datasource: 'qa-orders',
    plugin: 'mysql',
    capability: 'executeRead',
    query: { native: sql },
    result: { columns: ['ok'], rows: [{ ok: 1 }] },
    timings: {
      startedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: 42,
    },
    warnings: [],
    classification: 'success',
  };
}

describe('schema learning edge cases', () => {
  it('handles empty string', () => {
    const shape = extractQueryShape('');
    expect(shape.operation).toBe('');
    expect(shape.tables).toEqual([]);
    expect(shape.joins).toEqual([]);
    expect(shape.columns).toEqual([]);
  });

  it('handles malformed SQL gracefully', () => {
    expect(() => extractQueryShape('NOT VALID SQL AT ALL')).not.toThrow();
    expect(extractQueryShape('NOT VALID SQL AT ALL').tables).toEqual([]);
  });

  it('handles single-table SELECT without WHERE', () => {
    const shape = extractQueryShape('SELECT * FROM users');
    expect(shape.operation).toBe('select');
    expect(shape.tables).toEqual([{ table: 'users', alias: undefined }]);
    expect(shape.joins).toEqual([]);
    expect(shape.columns).toContainEqual({ column: '*', role: 'select', table: undefined });
  });

  it('handles INSERT statement', () => {
    const shape = extractQueryShape('INSERT INTO users (name) VALUES ("x")');
    expect(shape.operation).toBe('insert');
    expect(shape.tables.map((row) => row.table)).toContain('users');
  });

  it('handles UPDATE statement', () => {
    const shape = extractQueryShape('UPDATE users SET name = "x" WHERE id = 1');
    expect(shape.operation).toBe('update');
    expect(shape.tables.map((row) => row.table)).toContain('users');
  });

  it('handles DELETE statement', () => {
    const shape = extractQueryShape('DELETE FROM users WHERE id = 1');
    expect(shape.operation).toBe('delete');
    expect(shape.tables.map((row) => row.table)).toContain('users');
  });

  it('handles subqueries', () => {
    const shape = extractQueryShape('SELECT * FROM orders WHERE customer_id IN (SELECT id FROM customers)');
    expect(shape.tables.map((row) => row.table).sort()).toEqual(['customers', 'orders']);
  });

  it('ignores cte names as physical tables', () => {
    const shape = extractQueryShape(
      'WITH recent AS (SELECT id FROM users) SELECT * FROM recent JOIN orders o ON o.user_id = recent.id',
    );
    expect(shape.tables.map((row) => row.table).sort()).toEqual(['orders', 'users']);
    expect(shape.tables.map((row) => row.table)).not.toContain('recent');
  });

  it('handles SHOW/DESCRIBE/EXPLAIN prefixes', () => {
    expect(extractQueryShape('SHOW TABLES').operation).toBe('show');
    expect(extractQueryShape('DESCRIBE users').operation).toBe('describe');
    expect(extractQueryShape('EXPLAIN SELECT * FROM users').operation).toBe('explain');
  });

  it('normalizes literal values', () => {
    const shape = extractQueryShape("SELECT * FROM t WHERE x = 'secret' AND y = 42");
    expect(shape.normalizedSql).not.toContain('secret');
    expect(shape.normalizedSql).not.toContain('42');
  });

  it('dedup: repeated table sightings increment, a new table creates a new entry', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-learning-edge-'));
    const store = new LearningStore(dir);
    const datasource = mkDatasource();

    store.saveSuccess({ datasource, sql: 'SELECT * FROM orders WHERE id = 1' });
    store.saveSuccess({ datasource, sql: 'SELECT * FROM orders WHERE id = 2' });
    store.saveSuccess({ datasource, sql: 'SELECT * FROM customers WHERE status = "open"' });

    const tables = store.schemaTables('orders');
    expect(tables.map((row) => row.table).sort()).toEqual(['customers', 'orders']);
    expect(tables.map((row) => row.sightings).sort((a, b) => a - b)).toEqual([1, 2]);
  });

  it('confidence stays within 0.35–1.0 range', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-learning-confidence-'));
    const store = new LearningStore(dir);
    const datasource = mkDatasource();
    const sql = 'SELECT * FROM orders WHERE id = 1';

    for (let i = 0; i < 30; i += 1) {
      store.saveSuccess({ datasource, sql });
    }
    for (let i = 0; i < 30; i += 1) {
      store.saveFailure(datasource);
    }

    const observation = store.schemaTables('orders')[0];
    const resolution = store.resolveConnection('qa', 'orders');
    expect(observation.confidence).toBeGreaterThanOrEqual(0.35);
    expect(observation.confidence).toBeLessThanOrEqual(1);
    expect((resolution?.confidence || 0)).toBeGreaterThanOrEqual(0.1);
    expect((resolution?.confidence || 0)).toBeLessThanOrEqual(1);
  });
});
