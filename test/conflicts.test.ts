import { describe, expect, it } from 'vitest';
import { datasourceKbConflicts } from '../src/core/conflicts.js';
import type { DatasourceProfile } from '../src/types/datasource.js';

describe('datasource kb conflicts', () => {
  it('detects mismatched fields', () => {
    const datasource: DatasourceProfile = {
      name: 'sample',
      kind: 'mysql',
      connection: {
        host: '127.0.0.1',
        port: 4406,
        database: 'sample_db',
      },
      credentialRef: 'sample',
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    const kb = {
      access_method: 'kubectl-portforward',
      engine: 'mysql',
      host: '127.0.0.1',
      port: 5500,
      database: 'app_sample_db',
    };
    const out = datasourceKbConflicts(datasource, kb);
    expect(out).toContain('port=4406 (kb:5500)');
    expect(out).toContain('database=sample_db (kb:app_sample_db)');
  });
});
