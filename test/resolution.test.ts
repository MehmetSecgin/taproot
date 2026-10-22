import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { datasourceKindsForQuery } from '../src/core/resolve-datasource.js';
import { DatasourceStore } from '../src/store/datasources.js';

describe('datasource resolution', () => {
  it('prefers highest confidence then latest updatedAt', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-test-'));
    const file = path.join(dir, 'datasources.json');
    const store = new DatasourceStore(file);

    store.save({
      name: 'a',
      kind: 'mysql',
      env: 'prod',
      service: 'svc',
      tags: [],
      connection: {},
      credentialRef: 'x',
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      updatedAt: '2026-03-01T00:00:00.000Z',
      confidence: 0.7,
    });
    store.save({
      name: 'b',
      kind: 'mysql',
      env: 'prod',
      service: 'svc',
      tags: [],
      connection: {},
      credentialRef: 'y',
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      updatedAt: '2026-03-02T00:00:00.000Z',
      confidence: 0.9,
    });

    const resolved = store.resolveByEnvService('prod', 'svc');
    expect(resolved?.name).toBe('b');
  });

  it('resolves exact env+namespace+service when namespace is provided', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-test-'));
    const file = path.join(dir, 'datasources.json');
    const store = new DatasourceStore(file);

    store.save({
      name: 'qa-develop-svc',
      kind: 'mysql',
      env: 'qa',
      namespace: 'develop',
      service: 'svc',
      tags: [],
      connection: {},
      credentialRef: 'qa',
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      updatedAt: '2026-03-01T00:00:00.000Z',
      confidence: 0.7,
    });
    store.save({
      name: 'qa-test-svc',
      kind: 'mysql',
      env: 'qa',
      namespace: 'test',
      service: 'svc',
      tags: [],
      connection: {},
      credentialRef: 'qa',
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      updatedAt: '2026-03-02T00:00:00.000Z',
      confidence: 0.9,
    });

    expect(store.resolveByEnvService('qa', 'svc', 'develop')?.name).toBe('qa-develop-svc');
    expect(store.resolveByEnvService('qa', 'svc', 'test')?.name).toBe('qa-test-svc');
  });

  it('prefers a datasource of the requested kind over a higher-confidence one of another kind', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-test-'));
    const store = new DatasourceStore(path.join(dir, 'datasources.json'));
    const base = {
      env: 'qa',
      service: 'svc',
      tags: [],
      connection: {},
      credentialRef: 'qa',
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      updatedAt: '2026-03-01T00:00:00.000Z',
    };
    store.save({ ...base, name: 'qa-svc-grpc', kind: 'grpc', confidence: 0.9 } as never);
    store.save({ ...base, name: 'qa-svc-sql', kind: 'mysql', confidence: 0.5 } as never);

    expect(store.resolveByEnvService('qa', 'svc')?.name).toBe('qa-svc-grpc');
    expect(store.resolveByEnvService('qa', 'svc', undefined, ['mysql'])?.name).toBe('qa-svc-sql');
    expect(store.resolveByEnvService('qa', 'svc', undefined, ['redis'])?.name).toBe('qa-svc-grpc');
  });
});

describe('datasourceKindsForQuery', () => {
  it('maps SQL statements to the sql kinds', () => {
    for (const query of [
      'SELECT 1',
      '  select * from orders',
      'SHOW COLUMNS FROM orders',
      'WITH recent AS (SELECT 1) SELECT * FROM recent',
      'DESCRIBE orders',
      'desc orders',
      'EXPLAIN SELECT 1',
      'INSERT INTO orders VALUES (1)',
      'UPDATE orders SET id = 2',
      'DELETE FROM orders',
      'REPLACE INTO orders VALUES (1)',
    ]) {
      expect(datasourceKindsForQuery(query), query).toEqual(['mysql', 'teleport-mysql']);
    }
  });

  it('maps Package.Service/method to the grpc kind', () => {
    expect(datasourceKindsForQuery('taproot.test.ProfileService/getProfile')).toEqual(['grpc']);
    expect(datasourceKindsForQuery('update.v1.AddressService/select')).toEqual(['grpc']);
  });

  it('expresses no preference for anything else', () => {
    expect(datasourceKindsForQuery('GET orders:1')).toEqual([]);
    expect(datasourceKindsForQuery('')).toEqual([]);
  });
});
