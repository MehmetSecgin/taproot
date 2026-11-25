import { describe, expect, it, vi } from 'vitest';
import { executeQuery, silentQueryReport } from '../src/core/execute-query.js';
import { ensureDatasourceCatalog } from '../src/core/schema-refresh.js';
import { storeResolver, useDefaultQueryState } from './helpers/execute-query-state.js';
import { unknownColumnPlugin } from './helpers/execute-query-plugins.js';
import { fakePlugin } from './helpers/fake-plugin.js';
import { contextWith, findDatasource, queryRequest, setupQueryState } from './helpers/query-state.js';
import { expectFailure } from './helpers/query-outcome.js';
import { waitMs } from '../src/core/wait.js';

describe('executeQuery failure', () => {
  useDefaultQueryState();

  it('rejects a malformed param', async () => {
    const ctx = contextWith(fakePlugin());
    const outcome = await executeQuery(queryRequest({ params: ['brokenpair'] }), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver });
    const failure = expectFailure(outcome);
    expect(failure.code).toBe('BAD_INPUT');
    expect(failure.message).toContain("Invalid --param 'brokenpair'");
  });

  it('rejects an empty query', async () => {
    const ctx = contextWith(fakePlugin());
    const outcome = await executeQuery(queryRequest({ query: '   ' }), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver });
    const failure = expectFailure(outcome);
    expect(failure.message).toContain('No query resolved');
  });

  it('blocks a mutating query without allowMutate', async () => {
    const ctx = contextWith(fakePlugin());
    const outcome = await executeQuery(queryRequest({ query: 'DELETE FROM orders' }), {
      ctx,
      report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver,
    });
    const failure = expectFailure(outcome);
    expect(failure.message).toContain('--allow-mutate');
  });

  it('blocks a statement outside the SQL read allowlist', async () => {
    await setupQueryState({ kind: 'mysql' });
    const ctx = contextWith(fakePlugin({ kind: 'mysql' }));
    const outcome = await executeQuery(queryRequest({ query: 'CALL refresh_totals()' }), {
      ctx,
      report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver,
    });
    const failure = expectFailure(outcome);
    expect(failure.message).toContain('--allow-mutate');
  });

  it('classifies a plugin failure and keeps the schema context', async () => {
    const ctx = contextWith(fakePlugin({ failWith: 'access denied for user' }));
    const outcome = await executeQuery(queryRequest(), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver });
    const failure = expectFailure(outcome);
    expect(failure.code).toBe('ACCESS_DENIED');
    expect(outcome.meta.schemaContext).toBeDefined();
  });

  it('adds did-you-mean column suggestions from the cached catalog', async () => {
    // arrange
    const ctx = contextWith(fakePlugin({ failWith: "Unknown column 'customer_ident' in 'field list'" }));
    ctx.schemaCatalogStore.save('qa-fake', {
      orders: { database: 'fake', columns: ['id', 'customer_id', 'created_at'], primaryKey: ['id'], indexes: [] },
    });

    // act
    const outcome = await executeQuery(queryRequest({ query: 'SELECT customer_ident FROM orders' }), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver });

    // assert
    const failure = expectFailure(outcome);
    expect(failure.code).toBe('UNKNOWN_COLUMN');
    expect(failure.message).toContain('Did you mean: orders.customer_id');
    expect(JSON.stringify(failure.details)).toContain('orders.customer_id');
  });

  it('refetches the catalog at most once while an agent retries unknown columns', async () => {
    // arrange
    await setupQueryState({ kind: 'mysql' });
    const catalogQueries: string[] = [];
    const ctx = contextWith(unknownColumnPlugin(catalogQueries));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() - 2 * 60 * 1000);
    ctx.schemaCatalogStore.save('qa-fake', {});
    vi.useRealTimers();
    const joinRefetch = { sessionId: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver, afterSchemaError: true };

    // act
    for (const attempt of ['customer_ident', 'customer_idnt', 'customerid']) {
      await executeQuery(queryRequest({ query: `SELECT ${attempt} FROM orders` }), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver });
      await ensureDatasourceCatalog(ctx, findDatasource(ctx, 'qa-fake'), joinRefetch);
    }

    // assert
    expect(catalogQueries.filter((sql) => sql.includes('information_schema.columns'))).toHaveLength(1);
  });

  it('fails when no plugin serves the datasource kind', async () => {
    const ctx = contextWith(fakePlugin({ kind: 'other' }));
    const outcome = await executeQuery(queryRequest(), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver });
    const failure = expectFailure(outcome);
    expect(failure.message).toContain('No execute-capable plugin');
  });

  it('fails when the datasource cannot be resolved', async () => {
    const ctx = contextWith(fakePlugin());
    const outcome = await executeQuery(queryRequest({ datasource: 'missing', env: '', service: '' }), {
      ctx,
      report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver,
    });
    const failure = expectFailure(outcome);
    expect(failure.message).toContain('Datasource resolution failed');
  });
});

describe('executeQuery timeout', () => {
  useDefaultQueryState();

  it('starts the query timeout after the connectors are ready', async () => {
    // arrange
    await setupQueryState({ connectors: ['slow-connector'] });
    const ctx = contextWith(fakePlugin({ holdMs: 100 }));
    ctx.pluginRegistry.set('slow-connector', {
      ...fakePlugin({ kind: 'slow-connector' }),
      connect: async () => {
        await waitMs(150);
        return [];
      },
    });

    // act
    const outcome = await executeQuery(queryRequest({ timeoutMs: 200 }), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver });

    // assert
    expect(outcome.ok).toBe(true);
  });
});

describe('executeQuery access denied', () => {
  useDefaultQueryState();

  it('fails with ACCESS_DENIED without retrying', async () => {
    const ctx = contextWith(fakePlugin({ failWith: 'access denied for user' }));
    await ctx.credentialStore.set('qa:fake', { user: 'x' });
    const outcome = await executeQuery(queryRequest(), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver });
    const failure = expectFailure(outcome);
    expect(failure.code).toBe('ACCESS_DENIED');
  });
});

