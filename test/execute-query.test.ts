import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveQueryTarget, executeQuery, silentQueryReport } from '../src/core/execute-query.js';
import { ensureDatasourceCatalog } from '../src/core/schema-refresh.js';
import type { QueryReport } from '../src/core/execute-query.js';
import { DatasourceStore } from '../src/store/datasources.js';
import type { DatasourceProfile, QueryResult, TapRootPlugin } from '../src/types/core.js';
import { fakePlugin } from './helpers/fake-plugin.js';
import { contextWith, queryRequest, restoreQueryEnv, setupQueryState } from './helpers/query-state.js';

let stateRoot = '';

function recordingReport(): { report: QueryReport; logs: string[] } {
  const logs: string[] = [];
  return { logs, report: { log: (m) => logs.push(m) } };
}

function capturingPlugin(capture: { query?: string; creds?: Record<string, string> }): TapRootPlugin {
  const plugin = fakePlugin();
  const inner = plugin.execute!;
  plugin.execute = async (request, creds): Promise<QueryResult> => {
    capture.query = request.query;
    capture.creds = creds;
    return inner(request, creds);
  };
  return plugin;
}

beforeEach(async () => {
  stateRoot = await setupQueryState();
});

afterEach(() => {
  restoreQueryEnv();
});

describe('executeQuery success', () => {
  it('returns the shaped envelope and phase timings', async () => {
    // arrange
    const ctx = contextWith(fakePlugin());
    const recorder = recordingReport();

    // act
    const outcome = await executeQuery(queryRequest(), { ctx, report: recorder.report });

    // assert
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.data).toMatchObject({
      columns: ['ok'],
      rows: [[1]],
      rowsForm: 'array',
      datasource: 'qa-fake',
      plugin: 'fake',
      classification: 'success',
    });
    expect(outcome.meta.resolved).toMatchObject({ env: 'qa', service: 'fake', engine: 'fake' });
    expect(Object.keys(outcome.meta.phases || {})).toEqual(['resolveMs', 'connectMs', 'executeMs', 'totalMs']);
  });

  it('omits rowsForm and returns objects when rowsObject is set', async () => {
    const ctx = contextWith(fakePlugin());
    const outcome = await executeQuery(queryRequest({ rowsObject: true }), { ctx, report: silentQueryReport });
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.data.rows).toEqual([{ ok: 1 }]);
    expect(outcome.data.rowsForm).toBeUndefined();
  });

  it('wraps the query with EXPLAIN when explain is set', async () => {
    const capture: { query?: string } = {};
    const ctx = contextWith(capturingPlugin(capture));
    await executeQuery(queryRequest({ explain: true }), { ctx, report: silentQueryReport });
    expect(capture.query).toBe('EXPLAIN SELECT 1 AS ok');
  });

  it('applies json extract specs to the returned columns', async () => {
    const ctx = contextWith(fakePlugin({ columns: ['payload'], rows: [{ payload: '{"order":{"id":7}}' }] }));
    const outcome = await executeQuery(queryRequest({ jsonExtract: ['payload:order.id'] }), {
      ctx,
      report: silentQueryReport,
    });
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.data.columns).toContain('payload.order.id');
    expect(outcome.data.rows[0]).toEqual(['{"order":{"id":7}}', 7]);
  });

  it('reports plugin warnings once', async () => {
    const ctx = contextWith(fakePlugin({ warnings: ['slow scan'] }));
    const outcome = await executeQuery(queryRequest(), { ctx, report: silentQueryReport });
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.data.warnings).toEqual(['slow scan']);
  });

  it('returns without waiting for a cold catalog fetch, which then lands in the cache', async () => {
    // arrange
    stateRoot = await setupQueryState({ kind: 'mysql' });
    let releaseCatalog: () => void = () => {};
    const catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    const catalogQueries: string[] = [];
    const plugin = fakePlugin({ kind: 'mysql' });
    const inner = plugin.execute!;
    plugin.execute = async (request, creds): Promise<QueryResult> => {
      if (request.query.includes('information_schema')) {
        catalogQueries.push(request.query);
        await catalogGate;
      }
      return inner(request, creds);
    };
    const ctx = contextWith(plugin);

    // act
    const outcome = await executeQuery(queryRequest(), { ctx, report: silentQueryReport });
    const cachedBeforeRelease = ctx.schemaCatalogStore.get('qa-fake');
    releaseCatalog();
    const landed = await ensureDatasourceCatalog(ctx, ctx.datasourceStore.get('qa-fake')!);

    // assert
    expect(outcome.ok).toBe(true);
    expect(cachedBeforeRelease).toBeUndefined();
    expect(landed.outcome).toBe('fetched');
    expect(ctx.schemaCatalogStore.get('qa-fake')).toBeDefined();
    expect(catalogQueries.filter((sql) => sql.includes('information_schema.columns'))).toHaveLength(1);
  });
});

describe('executeQuery session identity', () => {
  it('passes the id from openSession to the plugin credentials', async () => {
    const capture: { creds?: Record<string, string> } = {};
    const ctx = contextWith(capturingPlugin(capture));
    const outcome = await executeQuery(queryRequest(), {
      ctx,
      report: silentQueryReport,
      openSession: () => 'session-123',
    });
    expect(capture.creds?.__sessionId).toBe('session-123');
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.meta.sessionId).toBe('session-123');
  });

  it('calls openSession with the resolved datasource', async () => {
    const ctx = contextWith(fakePlugin());
    const openSession = vi.fn((_datasource: DatasourceProfile) => 'session-abc');
    await executeQuery(queryRequest(), { ctx, report: silentQueryReport, openSession });
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(openSession.mock.calls[0][0]).toMatchObject({ name: 'qa-fake', kind: 'fake' });
  });

  it('omits the session marker when no session is opened', async () => {
    const capture: { creds?: Record<string, string> } = {};
    const ctx = contextWith(capturingPlugin(capture));
    await executeQuery(queryRequest(), { ctx, report: silentQueryReport });
    expect(capture.creds?.__sessionId).toBeUndefined();
  });
});

describe('executeQuery failure', () => {
  it('rejects a malformed param', async () => {
    const ctx = contextWith(fakePlugin());
    const outcome = await executeQuery(queryRequest({ params: ['brokenpair'] }), { ctx, report: silentQueryReport });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('BAD_INPUT');
    expect(outcome.message).toContain("Invalid --param 'brokenpair'");
  });

  it('rejects an empty query', async () => {
    const ctx = contextWith(fakePlugin());
    const outcome = await executeQuery(queryRequest({ query: '   ' }), { ctx, report: silentQueryReport });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('No query resolved');
  });

  it('blocks a mutating query without allowMutate', async () => {
    const ctx = contextWith(fakePlugin());
    const outcome = await executeQuery(queryRequest({ query: 'DELETE FROM orders' }), {
      ctx,
      report: silentQueryReport,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('--allow-mutate');
  });

  it('classifies a plugin failure and keeps the schema context', async () => {
    const ctx = contextWith(fakePlugin({ failWith: 'access denied for user' }));
    const outcome = await executeQuery(queryRequest(), { ctx, report: silentQueryReport });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('ACCESS_DENIED');
    expect(outcome.meta.schemaContext).toBeDefined();
  });

  it('adds did-you-mean column suggestions from the cached catalog', async () => {
    // arrange
    const ctx = contextWith(fakePlugin({ failWith: "Unknown column 'customer_ident' in 'field list'" }));
    ctx.schemaCatalogStore.save('qa-fake', {
      orders: { database: 'fake', columns: ['id', 'customer_id', 'created_at'], primaryKey: ['id'], indexes: [] },
    });

    // act
    const outcome = await executeQuery(queryRequest({ query: 'SELECT customer_ident FROM orders' }), { ctx, report: silentQueryReport });

    // assert
    if (outcome.ok) throw new Error('expected failure');
    expect(outcome.code).toBe('UNKNOWN_COLUMN');
    expect(outcome.message).toContain('Did you mean: orders.customer_id');
    expect(outcome.details).toMatchObject({ didYouMean: expect.arrayContaining(['orders.customer_id']) });
  });

  it('fails when no plugin serves the datasource kind', async () => {
    const ctx = contextWith(fakePlugin({ kind: 'other' }));
    const outcome = await executeQuery(queryRequest(), { ctx, report: silentQueryReport });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('No execute-capable plugin');
  });

  it('fails when the datasource cannot be resolved', async () => {
    const ctx = contextWith(fakePlugin());
    const outcome = await executeQuery(queryRequest({ datasource: 'missing', env: '', service: '' }), {
      ctx,
      report: silentQueryReport,
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toContain('Datasource resolution failed');
  });
});

describe('executeQuery datasource kind routing', () => {
  function saveProfile(overrides: Partial<DatasourceProfile>): void {
    new DatasourceStore(path.join(stateRoot, 'config', 'datasources.json')).save({
      name: 'qa-svc-sql',
      kind: 'mysql',
      env: 'qa',
      service: 'svc',
      tags: [],
      connection: { host: '127.0.0.1', port: 1, database: 'svc' },
      credentialRef: 'qa:fake',
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      updatedAt: new Date().toISOString(),
      confidence: 0.5,
      ...overrides,
    } as DatasourceProfile);
  }

  function bothKinds() {
    const ctx = contextWith(fakePlugin({ kind: 'grpc' }));
    ctx.pluginRegistry.set('mysql', fakePlugin({ kind: 'mysql' }));
    return ctx;
  }

  it('sends SQL text to the sql datasource when env and service also match a grpc one', async () => {
    stateRoot = await setupQueryState({ name: 'qa-svc-grpc', kind: 'grpc', service: 'svc', confidence: 1 });
    saveProfile({ name: 'qa-svc-sql', kind: 'mysql', confidence: 0.5 });
    const outcome = await executeQuery(queryRequest({ datasource: undefined, service: 'svc', query: 'SELECT 1 AS ok' }), {
      ctx: bothKinds(),
      report: silentQueryReport,
    });
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.data.datasource).toBe('qa-svc-sql');
  });

  it('sends Service/method text to the grpc datasource when env and service also match a sql one', async () => {
    stateRoot = await setupQueryState({ name: 'qa-svc-grpc', kind: 'grpc', service: 'svc', confidence: 0.5 });
    saveProfile({ name: 'qa-svc-sql', kind: 'mysql', confidence: 1 });
    const outcome = await executeQuery(
      queryRequest({ datasource: undefined, service: 'svc', query: 'taproot.test.ProfileService/getProfile' }),
      { ctx: bothKinds(), report: silentQueryReport },
    );
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.data.datasource).toBe('qa-svc-grpc');
  });

  it('keeps the only matching datasource even when its kind does not fit the query', async () => {
    stateRoot = await setupQueryState({ name: 'qa-svc-grpc', kind: 'grpc', service: 'svc' });
    const outcome = await executeQuery(queryRequest({ datasource: undefined, service: 'svc', query: 'SELECT 1 AS ok' }), {
      ctx: bothKinds(),
      report: silentQueryReport,
    });
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.data.datasource).toBe('qa-svc-grpc');
  });

  it('honours an explicit --datasource regardless of the query text', async () => {
    stateRoot = await setupQueryState({ name: 'qa-svc-grpc', kind: 'grpc', service: 'svc', confidence: 1 });
    saveProfile({ name: 'qa-svc-sql', kind: 'mysql', confidence: 0.5 });
    const outcome = await executeQuery(queryRequest({ datasource: 'qa-svc-grpc', service: 'svc', query: 'SELECT 1 AS ok' }), {
      ctx: bothKinds(),
      report: silentQueryReport,
    });
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.data.datasource).toBe('qa-svc-grpc');
  });
});

describe('executeQuery timeout', () => {
  it('starts the query timeout after the connectors are ready', async () => {
    // arrange
    stateRoot = await setupQueryState({ connectors: ['slow-connector'] });
    const ctx = contextWith(fakePlugin({ holdMs: 100 }));
    ctx.pluginRegistry.set('slow-connector', {
      ...fakePlugin({ kind: 'slow-connector' }),
      connect: async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return [];
      },
    });

    // act
    const outcome = await executeQuery(queryRequest({ timeoutMs: 200 }), { ctx, report: silentQueryReport });

    // assert
    expect(outcome.ok).toBe(true);
  });
});

describe('executeQuery access denied', () => {
  it('fails with ACCESS_DENIED without retrying', async () => {
    const ctx = contextWith(fakePlugin({ failWith: 'access denied for user' }));
    await ctx.credentialStore.set('qa:fake', { user: 'x' });
    const outcome = await executeQuery(queryRequest(), { ctx, report: silentQueryReport });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.code).toBe('ACCESS_DENIED');
  });
});

describe('deriveQueryTarget', () => {
  it('takes env, namespace and service from an explicit profile', async () => {
    const ctx = contextWith(fakePlugin());
    expect(deriveQueryTarget(ctx, { datasource: 'qa-fake' })).toMatchObject({ env: 'qa', service: 'fake' });
  });

  it('parses env and service out of an alias when no profile matches', async () => {
    const ctx = contextWith(fakePlugin());
    expect(deriveQueryTarget(ctx, { datasource: 'stg-orders' })).toMatchObject({ env: 'stg', service: 'orders' });
  });

  it('prefers explicit env and service over the alias', async () => {
    const ctx = contextWith(fakePlugin());
    expect(deriveQueryTarget(ctx, { datasource: 'stg-orders', env: 'qa', service: 'billing' })).toMatchObject({
      env: 'qa',
      service: 'billing',
    });
  });

  it('returns empty strings when nothing identifies the target', async () => {
    const ctx = contextWith(fakePlugin());
    expect(deriveQueryTarget(ctx, {})).toMatchObject({ env: '', service: '' });
  });
});
