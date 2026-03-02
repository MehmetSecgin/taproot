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
});
