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
    connection: { host: '127.0.0.1', port: 4406, database: 'orders' },
    credentialRef: 'qa:orders',
    connectors: ['openvpn', 'kubectl-portforward'],
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    updatedAt: new Date().toISOString(),
    confidence: 0.9,
  };
}

function mkResult(): QueryResult {
  return {
    runId: 'run-1',
    datasource: 'qa-orders',
    plugin: 'mysql',
    capability: 'executeRead',
    query: { native: 'SELECT 1' },
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

describe('schema learning extractor', () => {
  it('extracts tables, joins, and columns from select joins', () => {
    const sql =
      'SELECT o.id, c.customer_id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = "open" GROUP BY c.customer_id ORDER BY o.id DESC';
    const out = extractQueryShape(sql);

    expect(out.operation).toBe('select');
    expect(out.tables.map((t) => t.table).sort()).toEqual(['customers', 'orders']);
    expect(out.joins.length).toBeGreaterThan(0);
    expect(out.joins[0].conditionNormalized).toContain('c.id = o.customer_id');
    expect(out.columns.some((c) => c.role === 'select' && c.column === 'id')).toBe(true);
    expect(out.columns.some((c) => c.role === 'filter' && c.column === 'status')).toBe(true);
    expect(out.columns.some((c) => c.role === 'group' && c.column === 'customer_id')).toBe(true);
    expect(out.columns.some((c) => c.role === 'order' && c.column === 'id')).toBe(true);
  });
});

describe('schema learning store', () => {
  it('dedupes repeated observations and increments frequency', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-learning-'));
    const store = new LearningStore(dir);
    const datasource = mkDatasource();
    const sql =
      'SELECT o.id, c.customer_id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.status = 1 ORDER BY o.id DESC';

    store.saveSuccess({ datasource, sql });
    store.saveSuccess({ datasource, sql });

    const tables = store.schemaTables('orders');
    expect(tables.length).toBe(2);
    expect(tables.every((t) => t.sightings === 2)).toBe(true);

    const joins = store.schemaJoins('orders');
    expect(joins.length).toBe(1);
    expect(joins[0].sightings).toBe(2);
  });

  it('scrubs literal secrets from every learned file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-learning-'));
    const store = new LearningStore(dir);
    const datasource = mkDatasource();
    const sql = "SELECT id FROM users WHERE api_key = 'supersecret-token-123' AND user_id = 998877";

    store.saveSuccess({ datasource, sql });

    const learned = fs
      .readdirSync(dir)
      .map((name) => fs.readFileSync(path.join(dir, name), 'utf8'))
      .join('\n');
    expect(learned).not.toContain('supersecret-token-123');
    expect(learned).not.toContain('998877');
  });
});
