import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
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
});
