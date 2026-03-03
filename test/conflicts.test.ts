import { describe, expect, it } from 'vitest';
import { datasourceKbConflicts } from '../src/core/conflicts.js';

describe('datasource kb conflicts', () => {
  it('detects mismatched fields', () => {
    const datasource: any = {
      kind: 'mysql',
      connection: {
        host: '127.0.0.1',
        port: 4406,
        database: 'sample',
      },
    };
    const kb = {
      access_method: 'qa-portforward',
      engine: 'mysql',
      host: '127.0.0.1',
      port: 5500,
      database: 'app_sample_db',
    };
    const out = datasourceKbConflicts(datasource, kb);
    expect(out).toContain('port=4406 (kb:5500)');
    expect(out).toContain('database=sample (kb:app_sample_db)');
  });
});
