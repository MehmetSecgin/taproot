import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PluginRegistry } from '../src/plugins/registry.js';
import { LearningStore } from '../src/store/learning.js';
import { refreshSchemaForDatasource } from '../src/core/schema-refresh.js';
import type { AppContext } from '../src/core/app.js';

function makeContext(): AppContext {
  const learningDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-schema-refresh-'));
  const registry = new PluginRegistry();
  registry.register({
    manifest: {
      name: 'mysql',
      version: '0.1.0',
      kind: 'executor',
      capabilities: ['executeRead'],
    },
    async execute(request) {
      if (request.query.includes('information_schema.columns')) {
        return {
          runId: '',
          datasource: request.datasource.name,
          plugin: 'mysql',
          capability: request.capability,
          query: { native: request.query },
          result: {
            columns: ['table_name', 'column_name'],
            rows: [
              { table_name: 'orders', column_name: 'id' },
              { table_name: 'orders', column_name: 'status' },
              { table_name: 'customers', column_name: 'id' },
            ],
          },
          timings: { startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1 },
          warnings: [],
          classification: 'success',
        };
      }
      return {
        runId: '',
        datasource: request.datasource.name,
        plugin: 'mysql',
        capability: request.capability,
        query: { native: request.query },
        result: {
          columns: ['left_table', 'right_table', 'condition_raw', 'condition_normalized'],
          rows: [{ left_table: 'orders', right_table: 'customers', condition_raw: 'customer_id = id', condition_normalized: 'customer_id = id' }],
        },
        timings: { startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1 },
        warnings: [],
        classification: 'success',
      };
    },
  });
  return {
    paths: {
      stateRoot: learningDir,
      configDir: learningDir,
      runtimeConfigFile: path.join(learningDir, 'deterministic-config.json'),
      datasourceFile: path.join(learningDir, 'datasources.json'),
      credentialFile: path.join(learningDir, 'credentials.json.enc'),
      templatesFile: path.join(learningDir, 'templates.json'),
      cacheDir: path.join(learningDir, 'cache'),
      runsDir: path.join(learningDir, 'runs'),
      runsLedgerDir: path.join(learningDir, 'runs-ledger'),
      learningDir,
      kbDir: path.join(learningDir, 'kb'),
    },
    datasourceStore: {} as any,
    templateStore: {} as any,
    cardStore: {} as any,
    credentialStore: { get: async () => ({ user: 'reader', password: 'secret' }) } as any,
    kbStore: {} as any,
    learningStore: new LearningStore(learningDir),
    runtimeConfigStore: {} as any,
    pluginRegistry: registry,
    jsonMode: true,
    noColor: true,
    noAnimations: true,
    verbose: false,
  };
}

describe('schema refresh', () => {
  it('refreshes schema through TapRoot execution and persists learning rows', async () => {
    const ctx = makeContext();
    const datasource = {
      name: 'qa-orders',
      kind: 'mysql',
      env: 'qa',
      service: 'orders',
      tags: [],
      connection: { host: '127.0.0.1', port: 3306, database: 'orders' },
      credentialRef: 'qa:orders',
      connectors: [],
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      resolverHints: {},
      updatedAt: new Date().toISOString(),
      confidence: 0.9,
    };
    const refreshed = await refreshSchemaForDatasource(ctx, datasource as any);
    expect(refreshed.tables).toEqual([
      expect.objectContaining({ table: 'customers', columns: ['id'], indexes: [], primaryKey: [] }),
      expect.objectContaining({ table: 'orders', columns: ['id', 'status'], indexes: [], primaryKey: [] }),
    ]);
    expect(refreshed.joins).toHaveLength(1);

    const tables = ctx.learningStore.schemaTables('qa-orders');
    expect(tables.map((row) => row.table).sort()).toEqual(['customers', 'orders']);
    expect(tables.every((row) => row.sources.includes('refreshed-metadata'))).toBe(true);

    const joins = ctx.learningStore.schemaJoins('qa-orders');
    expect(joins[0].sources).toContain('refreshed-metadata');

    const shapes = ctx.learningStore.schemaQueryShapes('qa-orders');
    expect(shapes[0].operation).toBe('metadata-refresh');
  });

  it('extracts indexes and partitions from structured information_schema metadata', async () => {
    const ctx = makeContext();
    ctx.pluginRegistry.register({
      manifest: {
        name: 'mysql',
        version: '0.1.0',
        kind: 'executor',
        capabilities: ['executeRead'],
      },
      async execute(request) {
        const rows =
          request.query.includes('information_schema.columns')
            ? [
                { table_name: 'order_items', column_name: 'id' },
                { table_name: 'order_items', column_name: 'order_date' },
                { table_name: 'order_items', column_name: 'customer_id' },
              ]
            : request.query.includes('information_schema.statistics')
              ? [
                  { table_name: 'order_items', index_name: 'PRIMARY', seq_in_index: 1, column_name: 'id', non_unique: '0', index_type: 'BTREE' },
                  { table_name: 'order_items', index_name: 'idx_order_customer', seq_in_index: 1, column_name: 'order_date', non_unique: '1', index_type: 'BTREE' },
                  { table_name: 'order_items', index_name: 'idx_order_customer', seq_in_index: 2, column_name: 'customer_id', non_unique: '1', index_type: 'BTREE' },
                ]
              : request.query.includes('information_schema.partitions')
                ? [
                    { table_name: 'order_items', partition_method: 'RANGE', partition_expression: '`order_date`' },
                  ]
                : [];
        return {
          runId: '',
          datasource: request.datasource.name,
          plugin: 'mysql',
          capability: request.capability,
          query: { native: request.query },
          result: { columns: Object.keys(rows[0] || {}), rows },
          timings: { startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1 },
          warnings: [],
          classification: 'success',
        };
      },
    });
    const datasource = {
      name: 'qa-orders',
      kind: 'mysql',
      env: 'qa',
      service: 'orders',
      connection: { host: '127.0.0.1', database: 'order_service' },
      credentialRef: 'qa:orders',
      connectors: [],
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      updatedAt: new Date().toISOString(),
      confidence: 1,
    };

    const refreshed = await refreshSchemaForDatasource(ctx, datasource as any, { tables: ['order_items'] });
    expect(refreshed.tables[0]).toMatchObject({
      table: 'order_items',
      primaryKey: ['id'],
      indexes: [
        { name: 'PRIMARY', columns: ['id'], unique: true, type: 'BTREE' },
        { name: 'idx_order_customer', columns: ['order_date', 'customer_id'], unique: false, type: 'BTREE' },
      ],
      partition: { kind: 'RANGE', key: 'order_date', keys: ['order_date'] },
    });
  });

  it('falls back to SHOW CREATE for targeted metadata when information_schema access is denied', async () => {
    const ctx = makeContext();
    ctx.pluginRegistry.register({
      manifest: {
        name: 'mysql',
        version: '0.1.0',
        kind: 'executor',
        capabilities: ['executeRead'],
      },
      async execute(request) {
        if (request.query.includes('information_schema.statistics') || request.query.includes('information_schema.partitions')) {
          throw new Error('ACCESS_DENIED: SELECT command denied on information_schema');
        }
        const rows = request.query.startsWith('SHOW CREATE TABLE')
          ? [
              {
                Table: 'order_items',
                'Create Table': [
                  'CREATE TABLE `order_items` (',
                  '  `id` bigint NOT NULL,',
                  '  `order_date` date NOT NULL,',
                  '  `customer_id` bigint NOT NULL,',
                  '  PRIMARY KEY (`id`),',
                  '  KEY `idx_order_customer` (`order_date`,`customer_id`)',
                  ') PARTITION BY RANGE COLUMNS(`order_date`) (PARTITION p0 VALUES LESS THAN (MAXVALUE))',
                ].join('\n'),
              },
            ]
          : [];
        return {
          runId: '',
          datasource: request.datasource.name,
          plugin: 'mysql',
          capability: request.capability,
          query: { native: request.query },
          result: { columns: Object.keys(rows[0] || {}), rows },
          timings: { startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1 },
          warnings: [],
          classification: 'success',
        };
      },
    });
    const datasource = {
      name: 'qa-orders',
      kind: 'mysql',
      env: 'qa',
      service: 'orders',
      connection: { host: '127.0.0.1', database: 'order_service' },
      credentialRef: 'qa:orders',
      connectors: [],
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      updatedAt: new Date().toISOString(),
      confidence: 1,
    };

    const refreshed = await refreshSchemaForDatasource(ctx, datasource as any, { tables: ['order_items'] });

    expect(refreshed.tables[0]).toMatchObject({
      table: 'order_items',
      columns: ['order_date', 'id', 'customer_id'],
      primaryKey: ['id'],
      indexes: [
        { name: 'PRIMARY', columns: ['id'], unique: true },
        { name: 'idx_order_customer', columns: ['order_date', 'customer_id'], unique: false },
      ],
      partition: { kind: 'RANGE', key: 'order_date', keys: ['order_date'] },
    });
  });
});
