import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppContext } from '../src/core/app.js';
import { ensureSchemaSnapshot } from '../src/commands/learn.js';
import { PluginRegistry } from '../src/plugins/registry.js';
import { LearningStore } from '../src/store/learning.js';
import { DatasourceStore } from '../src/store/datasources.js';

function makeContext(input?: { datasources?: any[]; aliasMap?: Record<string, string> }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-ensure-schema-'));
  const configDir = path.join(root, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'datasources.json'), JSON.stringify(input?.datasources || []));
  fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');
  fs.writeFileSync(path.join(configDir, 'deterministic-config.json'), JSON.stringify({ serviceAliases: input?.aliasMap || {} }));

  let executeCount = 0;
  const registry = new PluginRegistry();
  registry.register({
    manifest: {
      name: 'mysql',
      version: '0.1.0',
      kind: 'executor',
      capabilities: ['executeRead'],
    },
    async execute(request) {
      executeCount += 1;
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
          rows: [],
        },
        timings: { startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1 },
        warnings: [],
        classification: 'success',
      };
    },
  });

  const ctx: AppContext = {
    paths: {
      stateRoot: root,
      configDir,
      configSnapshotsDir: path.join(root, 'config-snapshots'),
      runtimeConfigFile: path.join(configDir, 'deterministic-config.json'),
      datasourceFile: path.join(configDir, 'datasources.json'),
      credentialFile: path.join(configDir, 'credentials.json.enc'),
      templatesFile: path.join(configDir, 'templates.json'),
      cacheDir: path.join(root, 'cache'),
      runsDir: path.join(root, 'runs'),
      runsLedgerDir: path.join(root, 'learning', 'runs-ledger'),
      learningDir: path.join(root, 'learning'),
      kbDir: path.join(root, 'kb'),
    },
    datasourceStore: new DatasourceStore(path.join(configDir, 'datasources.json')),
    templateStore: {} as any,
    cardStore: {} as any,
    credentialStore: { get: async () => ({ user: 'reader', password: 'secret' }) } as any,
    kbStore: { resolveConnection: () => undefined } as any,
    learningStore: new LearningStore(path.join(root, 'learning')),
    runtimeConfigStore: { serviceAliases: () => input?.aliasMap || {} } as any,
    pluginRegistry: registry,
    jsonMode: true,
    noColor: true,
    noAnimations: true,
    verbose: false,
  };

  return { ctx, getExecuteCount: () => executeCount };
}

function datasource(name = 'qa-orders') {
  return {
    name,
    kind: 'mysql',
    env: 'qa',
    namespace: 'develop',
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
}

describe('learn ensure-schema', () => {
  it('returns cached learning without introspection when schema is already known', async () => {
    const { ctx, getExecuteCount } = makeContext({ datasources: [datasource()] });
    ctx.learningStore.saveSchemaRefresh({
      datasource: datasource() as any,
      source: 'manual',
      tables: [{ table: 'orders', columns: ['id', 'status'] }],
      joins: [],
    });

    const out = await ensureSchemaSnapshot(ctx, { datasource: 'qa-orders' });
    expect(out.ensuredBy).toBe('cached-learning');
    expect(out.tables).toHaveLength(1);
    expect(getExecuteCount()).toBe(0);
  });

  it('runs introspection when targeted schema learning is missing', async () => {
    const { ctx, getExecuteCount } = makeContext({ datasources: [datasource()] });
    const out = await ensureSchemaSnapshot(ctx, { datasource: 'qa-orders' });

    expect(out.ensuredBy).toBe('refreshed-introspection');
    expect(out.tables).toEqual([
      expect.objectContaining({ table: 'orders', columns: ['id', 'status'] }),
    ]);
    expect(getExecuteCount()).toBe(4);
  });

  it('refreshes when targeted schema learning lacks current metadata fields', async () => {
    const { ctx, getExecuteCount } = makeContext({ datasources: [datasource()] });
    ctx.learningStore.saveSuccess({
      datasource: datasource() as any,
      queryIntent: 'orders',
      sql: 'SELECT id FROM orders WHERE status = 1',
      result: {
        runId: 'run-1',
        datasource: 'qa-orders',
        plugin: 'mysql',
        capability: 'executeRead',
        query: { native: 'SELECT 1' },
        result: { columns: ['id'], rows: [{ id: 1 }] },
        timings: { startedAt: new Date().toISOString(), endedAt: new Date().toISOString(), durationMs: 1 },
        warnings: [],
        classification: 'success',
      },
    });

    const out = await ensureSchemaSnapshot(ctx, { datasource: 'qa-orders', tables: ['orders'] });

    expect(out.ensuredBy).toBe('refreshed-introspection');
    expect(getExecuteCount()).toBe(4);
  });

  it('returns unresolved without introspection when the targeted service cannot be resolved', async () => {
    const { ctx, getExecuteCount } = makeContext();
    const out = await ensureSchemaSnapshot(ctx, { env: 'develop', service: 'order-processor' });

    expect(out).toMatchObject({
      datasource: null,
      tables: [],
      joins: [],
      emptyReason: 'datasource_unresolved',
      suggestedNextCommand: 'taproot --json init datasource --env develop --service order-processor',
      ensuredBy: 'unresolved',
    });
    expect(getExecuteCount()).toBe(0);
  });

  it('resolves by env+namespace+service for targeted ensure-schema requests', async () => {
    const { ctx, getExecuteCount } = makeContext({ datasources: [datasource('qa-develop-orders')] });
    ctx.learningStore.saveSchemaRefresh({
      datasource: datasource('qa-develop-orders') as any,
      source: 'manual',
      tables: [{ table: 'orders', columns: ['id', 'status'] }],
      joins: [],
    });

    const out = await ensureSchemaSnapshot(ctx, { env: 'qa', namespace: 'develop', service: 'orders' });
    expect(out).toMatchObject({
      datasource: 'qa-develop-orders',
      ensuredBy: 'cached-learning',
    });
    expect(getExecuteCount()).toBe(0);
  });
});
