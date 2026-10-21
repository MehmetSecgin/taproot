import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PluginRegistry } from '../src/plugins/registry.js';
import { LearningStore } from '../src/store/learning.js';
import { ensureDatasourceCatalog } from '../src/core/schema-refresh.js';
import { buildSchemaContext } from '../src/core/schema-context.js';
import type { AppContext } from '../src/core/app.js';

function makeContext() {
  const learningDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-catalog-'));
  const seen: string[] = [];
  const registry = new PluginRegistry();
  registry.register({
    manifest: { name: 'mysql', version: '0.1.0', kind: 'executor', capabilities: ['executeRead'] },
    async execute(request) {
      seen.push(request.query);
      const rows = request.query.includes('information_schema.columns')
        ? [
            { table_name: 'orders', column_name: 'id' },
            { table_name: 'orders', column_name: 'order_date' },
            { table_name: 'customers', column_name: 'id' },
            { table_name: 'shipments', column_name: 'id' },
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
  const ctx: AppContext = {
    paths: {
      stateRoot: learningDir,
      configDir: learningDir,
      configSnapshotsDir: path.join(learningDir, 'config-snapshots'),
      runtimeConfigFile: path.join(learningDir, 'deterministic-config.json'),
      datasourceFile: path.join(learningDir, 'datasources.json'),
      credentialFile: path.join(learningDir, 'credentials.json.enc'),
      cacheDir: path.join(learningDir, 'cache'),
      runsDir: path.join(learningDir, 'runs'),
      runsLedgerDir: path.join(learningDir, 'runs-ledger'),
      learningDir,
      kbDir: path.join(learningDir, 'kb'),
    },
    datasourceStore: {} as any,
    credentialStore: { get: async () => ({ user: 'reader', password: 'secret' }) } as any,
    kbStore: {} as any,
    learningStore: new LearningStore(learningDir),
    runtimeConfigStore: {} as any,
    pluginRegistry: registry,
    verbose: false,
  };
  return { ctx, seen };
}

function datasource(kind = 'mysql') {
  return {
    name: 'qa-orders',
    kind,
    env: 'qa',
    service: 'orders',
    connection: { host: '127.0.0.1', port: 3306, database: 'orders' },
    credentialRef: 'qa:orders',
    connectors: [],
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    updatedAt: new Date().toISOString(),
    confidence: 1,
  } as any;
}

describe('eager schema catalog', () => {
  it('fetches the whole catalog once and reports the table count', async () => {
    // arrange
    const { ctx, seen } = makeContext();

    // act
    const out = await ensureDatasourceCatalog(ctx, datasource());

    // assert
    expect(out.outcome).toBe('fetched');
    expect(out.tableCount).toBe(3);
    expect(seen.some((sql) => sql.includes('information_schema.columns'))).toBe(true);
    expect(seen.every((sql) => !/table_name IN \(/i.test(sql))).toBe(true);
  });

  it('serves the second call from cache without re-introspecting', async () => {
    // arrange
    const { ctx, seen } = makeContext();
    await ensureDatasourceCatalog(ctx, datasource());
    const afterFirst = seen.length;

    // act
    const out = await ensureDatasourceCatalog(ctx, datasource());

    // assert
    expect(out.outcome).toBe('cached');
    expect(out.tableCount).toBe(3);
    expect(seen.length).toBe(afterFirst);
  });

  it('re-introspects once the cached catalog is past its TTL', async () => {
    // arrange
    const { ctx, seen } = makeContext();
    await ensureDatasourceCatalog(ctx, datasource());
    const afterFirst = seen.length;
    const catalogFile = path.join(ctx.paths.learningDir, 'schema-catalog.json');
    const rows = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    rows[0].fetchedAt = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    fs.writeFileSync(catalogFile, JSON.stringify(rows));

    // act
    const out = await ensureDatasourceCatalog(ctx, datasource());

    // assert
    expect(out.outcome).toBe('fetched');
    expect(seen.length).toBeGreaterThan(afterFirst);
  });

  it('reports unsupported kinds without touching the plugin', async () => {
    // arrange
    const { ctx, seen } = makeContext();

    // act
    const out = await ensureDatasourceCatalog(ctx, datasource('redis'));

    // assert
    expect(out).toEqual({ outcome: 'unsupported', tableCount: 0 });
    expect(seen).toEqual([]);
  });

  it('never fails the query when introspection throws', async () => {
    // arrange
    const { ctx } = makeContext();
    ctx.pluginRegistry.register({
      manifest: { name: 'mysql', version: '0.1.0', kind: 'executor', capabilities: ['executeRead'] },
      async execute() {
        throw new Error('connection refused');
      },
    });

    // act
    const out = await ensureDatasourceCatalog(ctx, datasource());

    // assert
    expect(out.outcome).toBe('failed');
    expect(out.error).toContain('connection refused');
  });

  it('surfaces the catalog summary in schemaContext', async () => {
    // arrange
    const { ctx } = makeContext();
    await ensureDatasourceCatalog(ctx, datasource());

    // act
    const context = buildSchemaContext(
      'SELECT id FROM orders',
      { service: 'orders', datasource: 'qa-orders', dialect: 'mysql' },
      ctx.learningStore,
    );

    // assert
    expect(context.catalog?.tables).toBe(3);
    expect(context.tables.orders.columns).toContain('order_date');
  });

  it('omits the catalog summary when no datasource is named', async () => {
    // arrange
    const { ctx } = makeContext();
    await ensureDatasourceCatalog(ctx, datasource());

    // act
    const context = buildSchemaContext('SELECT id FROM orders', { service: 'orders', dialect: 'mysql' }, ctx.learningStore);

    // assert
    expect(context.catalog).toBeUndefined();
  });
});
