import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveQueryTarget, executeQuery, silentQueryReport } from '../src/core/execute-query.js';
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
    expect(Object.keys(outcome.meta.phases || {})).toEqual(['resolveMs', 'catalogMs', 'connectMs', 'executeMs', 'totalMs']);
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

  it('runs the query while a stale catalog refreshes and reports catalogMs', async () => {
    // arrange
    stateRoot = await setupQueryState({ kind: 'mysql' });
    let releaseCatalog: () => void = () => {};
    const catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    const plugin = fakePlugin({ kind: 'mysql' });
    const inner = plugin.execute!;
    plugin.execute = async (request, creds): Promise<QueryResult> => {
      if (request.query.includes('information_schema')) await catalogGate;
      else releaseCatalog();
      return inner(request, creds);
    };
    const ctx = contextWith(plugin);
    ctx.schemaCatalogStore.save('qa-fake', {});
    const catalogFile = path.join(stateRoot, 'cache', 'schema', 'qa-fake.json');
    const catalog = JSON.parse(fs.readFileSync(catalogFile, 'utf8'));
    catalog.fetchedAt = new Date(Date.now() - 72 * 3600 * 1000).toISOString();
    fs.writeFileSync(catalogFile, JSON.stringify(catalog));
    const recorder = recordingReport();

    // act
    const outcome = await executeQuery(queryRequest(), { ctx, report: recorder.report });

    // assert
    expect(recorder.logs.join(' ')).not.toContain('caching its full schema catalog');
    if (!outcome.ok) throw new Error('expected success');
    expect(outcome.meta.phases?.catalogMs).toEqual(expect.any(Number));
  });

  it('emits the catalog notice on the first query against a sql datasource', async () => {
    stateRoot = await setupQueryState({ kind: 'mysql' });
    const ctx = contextWith(fakePlugin({ kind: 'mysql' }));
    const recorder = recordingReport();
    await executeQuery(queryRequest(), { ctx, report: recorder.report });
    expect(recorder.logs.join(' ')).toContain('caching its full schema catalog');
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
    ctx.pluginRegistry.register(fakePlugin({ kind: 'mysql' }));
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
