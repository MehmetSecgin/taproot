import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { datasourceKindsForQuery } from '../src/core/resolve-datasource.js';
import { DatasourceStore } from '../src/store/datasources.js';

describe('datasource resolution', () => {
  it('refuses to pick between two profiles that match env and service', () => {
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
    });

    expect(() => store.resolveByEnvService('prod', 'svc')).toThrow(
      'AMBIGUOUS_DATASOURCE: 2 datasources match env=prod service=svc: a, b. Narrow with --namespace, or use --datasource <name> on query and doctor.',
    );
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
    });

    expect(store.resolveByEnvService('qa', 'svc', 'develop')?.name).toBe('qa-develop-svc');
    expect(store.resolveByEnvService('qa', 'svc', 'test')?.name).toBe('qa-test-svc');
  });

  it('loads a profile saved with the removed confidence key', () => {
    // arrange
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-test-'));
    const file = path.join(dir, 'datasources.json');
    fs.writeFileSync(file, JSON.stringify([{
      name: 'qa-orders',
      kind: 'mysql',
      env: 'qa',
      service: 'orders',
      tags: [],
      connection: {},
      credentialRef: 'qa',
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      updatedAt: '2026-03-01T00:00:00.000Z',
      confidence: 0.8,
    }]));

    // act
    const loaded = new DatasourceStore(file).load();

    // assert
    expect(loaded.warnings).toEqual([]);
    expect(loaded.profiles.map((profile) => profile.name)).toEqual(['qa-orders']);
  });

  it('only offers --datasource when the namespace is already given', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-test-'));
    const store = new DatasourceStore(path.join(dir, 'datasources.json'));
    const base = {
      kind: 'grpc',
      env: 'qa',
      namespace: 'develop',
      service: 'svc',
      tags: [],
      connection: {},
      credentialRef: 'qa',
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      updatedAt: '2026-03-01T00:00:00.000Z',
    };
    store.save({ ...base, name: 'qa-svc-grpc' } as never);
    store.save({ ...base, name: 'qa-svc-legacy-grpc' } as never);

    expect(() => store.resolveByEnvService('qa', 'svc', 'develop', ['grpc'])).toThrow(
      'AMBIGUOUS_DATASOURCE: 2 datasources match env=qa namespace=develop service=svc: qa-svc-grpc, qa-svc-legacy-grpc. Pick one: use --datasource <name> on query and doctor.',
    );
  });

  it('picks the datasource of the requested kind and refuses to guess without one', () => {
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
    store.save({ ...base, name: 'qa-svc-grpc', kind: 'grpc' } as never);
    store.save({ ...base, name: 'qa-svc-sql', kind: 'mysql' } as never);

    expect(store.resolveByEnvService('qa', 'svc', undefined, ['mysql'])?.name).toBe('qa-svc-sql');
    expect(store.resolveByEnvService('qa', 'svc', undefined, ['grpc'])?.name).toBe('qa-svc-grpc');
    expect(() => store.resolveByEnvService('qa', 'svc')).toThrow('AMBIGUOUS_DATASOURCE');
    expect(() => store.resolveByEnvService('qa', 'svc', undefined, ['redis'])).toThrow('AMBIGUOUS_DATASOURCE');
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
