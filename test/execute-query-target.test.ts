import { describe, expect, it } from 'vitest';
import { deriveQueryTarget } from '../src/core/query-target.js';
import { useDefaultQueryState } from './helpers/execute-query-state.js';
import { fakePlugin } from './helpers/fake-plugin.js';
import { contextWith } from './helpers/query-state.js';

describe('derive query target', () => {
  useDefaultQueryState();

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
