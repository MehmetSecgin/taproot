import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { executeQuery, silentQueryReport } from '../src/core/execute-query.js';
import { DatasourceStore } from '../src/store/datasources.js';
import type { DatasourceProfile } from '../src/types/datasource.js';
import { storeResolver, useDefaultQueryState } from './helpers/execute-query-state.js';
import { fakePlugin } from './helpers/fake-plugin.js';
import { contextWith, queryRequest, setupQueryState } from './helpers/query-state.js';
import { expectSuccess } from './helpers/query-outcome.js';

function saveProfile(stateRoot: string, overrides: Partial<DatasourceProfile>): void {
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
    ...overrides,
  });
}

function bothKinds(): ReturnType<typeof contextWith> {
  const ctx = contextWith(fakePlugin({ kind: 'grpc' }));
  ctx.pluginRegistry.set('mysql', fakePlugin({ kind: 'mysql' }));
  return ctx;
}

describe('executeQuery datasource kind routing', () => {
  useDefaultQueryState();

  it('sends SQL text to the sql datasource when env and service also match a grpc one', async () => {
    const stateRoot = await setupQueryState({ name: 'qa-svc-grpc', kind: 'grpc', service: 'svc' });
    saveProfile(stateRoot, { name: 'qa-svc-sql', kind: 'mysql' });
    const outcome = await executeQuery(queryRequest({ datasource: undefined, service: 'svc', query: 'SELECT 1 AS ok' }), {
      ctx: bothKinds(),
      report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver,
    });
    const success = expectSuccess(outcome);
    expect(success.data.datasource).toBe('qa-svc-sql');
  });

  it('sends Service/method text to the grpc datasource when env and service also match a sql one', async () => {
    const stateRoot = await setupQueryState({ name: 'qa-svc-grpc', kind: 'grpc', service: 'svc' });
    saveProfile(stateRoot, { name: 'qa-svc-sql', kind: 'mysql' });
    const outcome = await executeQuery(
      queryRequest({ datasource: undefined, service: 'svc', query: 'taproot.test.ProfileService/getProfile' }),
      { ctx: bothKinds(), report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver },
    );
    const success = expectSuccess(outcome);
    expect(success.data.datasource).toBe('qa-svc-grpc');
  });

  it('keeps the only matching datasource even when its kind does not fit the query', async () => {
    await setupQueryState({ name: 'qa-svc-grpc', kind: 'grpc', service: 'svc' });
    const outcome = await executeQuery(queryRequest({ datasource: undefined, service: 'svc', query: 'SELECT 1 AS ok' }), {
      ctx: bothKinds(),
      report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver,
    });
    const success = expectSuccess(outcome);
    expect(success.data.datasource).toBe('qa-svc-grpc');
  });

  it('honours an explicit --datasource regardless of the query text', async () => {
    const stateRoot = await setupQueryState({ name: 'qa-svc-grpc', kind: 'grpc', service: 'svc' });
    saveProfile(stateRoot, { name: 'qa-svc-sql', kind: 'mysql' });
    const outcome = await executeQuery(queryRequest({ datasource: 'qa-svc-grpc', service: 'svc', query: 'SELECT 1 AS ok' }), {
      ctx: bothKinds(),
      report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver,
    });
    const success = expectSuccess(outcome);
    expect(success.data.datasource).toBe('qa-svc-grpc');
  });
});

