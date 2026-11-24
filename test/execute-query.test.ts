import { describe, expect, it } from 'vitest';
import { executeQuery, silentQueryReport } from '../src/core/execute-query.js';
import type { QueryReport } from '../src/core/query-types.js';
import { ensureDatasourceCatalog } from '../src/core/schema-refresh.js';
import { storeResolver, useDefaultQueryState } from './helpers/execute-query-state.js';
import { catalogGatedPlugin } from './helpers/execute-query-plugins.js';
import { fakePlugin, interceptExecute } from './helpers/fake-plugin.js';
import { contextWith, findDatasource, queryRequest, setupQueryState } from './helpers/query-state.js';
import { createDeferred } from './helpers/deferred.js';
import { expectSuccess } from './helpers/query-outcome.js';


function recordingReport(): { report: QueryReport; logs: string[] } {
  const logs: string[] = [];
  return {
    logs,
    report: {
      log: (message) => {
        logs.push(message);
      },
    },
  };
}

describe('executeQuery success', () => {
  useDefaultQueryState();

  it('cuts the rows of a plugin that returns more than maxRows and says so', async () => {
    // arrange
    const ctx = contextWith(fakePlugin({ rows: [[1], [2], [3]] }));

    // act
    const outcome = await executeQuery(queryRequest({ maxRows: 2 }), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver });

    // assert
    const success = expectSuccess(outcome);
    expect(success.data).toMatchObject({ rows: [[1], [2]], truncated: true });
  });

  it('leaves out truncated when the rows fit under maxRows', async () => {
    // arrange
    const ctx = contextWith(fakePlugin({ rows: [[1], [2]] }));

    // act
    const outcome = await executeQuery(queryRequest({ maxRows: 2 }), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver });

    // assert
    const success = expectSuccess(outcome);
    expect(success.data.rows).toStrictEqual([[1], [2]]);
    expect(success.data).not.toHaveProperty('truncated');
  });

  it('refuses a maxRows that is not a whole number of 1 or more', async () => {
    // arrange
    const ctx = contextWith(fakePlugin());

    // act
    const outcome = await executeQuery(queryRequest({ maxRows: 0 }), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver });

    // assert
    expect(outcome).toMatchObject({ ok: false, code: 'BAD_INPUT' });
  });

  it('returns the shaped envelope and phase timings', async () => {
    // arrange
    const ctx = contextWith(fakePlugin());
    const recorder = recordingReport();

    // act
    const outcome = await executeQuery(queryRequest(), { ctx, report: recorder.report, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver });

    // assert
    const success = expectSuccess(outcome);
    expect(success.data).toMatchObject({
      columns: ['ok'],
      rows: [[1]],
      rowsForm: 'array',
      datasource: 'qa-fake',
      plugin: 'fake',
      classification: 'success',
    });
    expect(success.meta.resolved).toMatchObject({ env: 'qa', service: 'fake', engine: 'fake' });
    expect(Object.keys({ ...success.meta.phases })).toStrictEqual(['resolveMs', 'connectMs', 'executeMs', 'totalMs']);
  });

  it('omits rowsForm and returns objects when rowsObject is set', async () => {
    const ctx = contextWith(fakePlugin());
    const outcome = await executeQuery(queryRequest({ rowsObject: true }), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver });
    const success = expectSuccess(outcome);
    expect(success.data.rows).toStrictEqual([{ ok: 1 }]);
    expect(success.data.rowsForm).toBeUndefined();
  });

  it('keeps both values when two columns share a name', async () => {
    // arrange
    const ctx = contextWith(fakePlugin({ columns: ['id', 'id'], rows: [[7, 9]] }));

    // act
    const outcome = await executeQuery(queryRequest(), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver });

    // assert
    const success = expectSuccess(outcome);
    expect(success.data.columns).toStrictEqual(['id', 'id']);
    expect(success.data.rows).toStrictEqual([[7, 9]]);
  });

  it('keys each value by its column name when rowsObject is set', async () => {
    // arrange
    const ctx = contextWith(fakePlugin({ columns: ['id', 'name', 'payload'], rows: [[7, 'Ada', '{"order":{"id":3}}']] }));

    // act
    const outcome = await executeQuery(queryRequest({ rowsObject: true, jsonExtract: ['payload:order.id'] }), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver });

    // assert
    const success = expectSuccess(outcome);
    expect(success.data.rows).toStrictEqual([{ id: 7, name: 'Ada', payload: '{"order":{"id":3}}', 'payload.order.id': 3 }]);
  });

  it('wraps the query with EXPLAIN when explain is set', async () => {
    const queries: string[] = [];
    const ctx = contextWith(interceptExecute(fakePlugin(), (request) => {
      queries.push(request.query);
    }));
    await executeQuery(queryRequest({ explain: true }), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver });
    expect(queries).toStrictEqual(['EXPLAIN SELECT 1 AS ok']);
  });

  it('applies json extract specs to the returned columns', async () => {
    const ctx = contextWith(fakePlugin({ columns: ['payload'], rows: [['{"order":{"id":7}}']] }));
    const outcome = await executeQuery(queryRequest({ jsonExtract: ['payload:order.id'] }), {
      ctx,
      report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver,
    });
    const success = expectSuccess(outcome);
    expect(success.data.columns).toContain('payload.order.id');
    expect(success.data.rows[0]).toStrictEqual(['{"order":{"id":7}}', 7]);
  });

  it('reports plugin warnings once', async () => {
    const ctx = contextWith(fakePlugin({ warnings: ['slow scan'] }));
    const outcome = await executeQuery(queryRequest(), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver });
    const success = expectSuccess(outcome);
    expect(success.data.warnings).toStrictEqual(['slow scan']);
  });

  it('returns without waiting for a cold catalog fetch, which then lands in the cache', async () => {
    // arrange
    await setupQueryState({ kind: 'mysql' });
    const catalogGate = createDeferred();
    const catalogQueries: string[] = [];
    const ctx = contextWith(catalogGatedPlugin(catalogGate.promise, catalogQueries));

    // act
    const outcome = await executeQuery(queryRequest(), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver });
    const cachedBeforeRelease = ctx.schemaCatalogStore.get('qa-fake');
    catalogGate.resolve();
    const landed = await ensureDatasourceCatalog(ctx, findDatasource(ctx, 'qa-fake'), { sessionId: undefined, acquireQuerySlot: undefined, afterSchemaError: false });

    // assert
    expect(outcome.ok).toBe(true);
    expect(cachedBeforeRelease).toBeUndefined();
    expect(landed.outcome).toBe('fetched');
    expect(ctx.schemaCatalogStore.get('qa-fake')).toBeDefined();
    expect(catalogQueries.filter((sql) => sql.includes('information_schema.columns'))).toHaveLength(1);
  });
});
