import { describe, expect, it, vi } from 'vitest';
import { executeQuery, silentQueryReport } from '../src/core/execute-query.js';
import type { DatasourceProfile } from '../src/types/datasource.js';
import type { TapRootPlugin } from '../src/types/plugin.js';
import { storeResolver, useDefaultQueryState } from './helpers/execute-query-state.js';
import { fakePlugin, interceptExecute } from './helpers/fake-plugin.js';
import { contextWith, queryRequest } from './helpers/query-state.js';
import { expectSuccess } from './helpers/query-outcome.js';

const SESSION_ID_KEY = '__sessionId';

function capturingPlugin(capture: { query?: string; creds?: Record<string, string> }): TapRootPlugin {
  return interceptExecute(fakePlugin(), (request, creds) => {
    capture.query = request.query;
    capture.creds = creds;
  });
}

describe('executeQuery session identity', () => {
  useDefaultQueryState();

  it('passes the id from openSession to the plugin credentials', async () => {
    const capture: { creds?: Record<string, string> } = {};
    const ctx = contextWith(capturingPlugin(capture));
    const outcome = await executeQuery(queryRequest(), {
      ctx,
      report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver,
      openSession: () => 'session-123',
    });
    expect(capture.creds?.[SESSION_ID_KEY]).toBe('session-123');
    const success = expectSuccess(outcome);
    expect(success.meta.sessionId).toBe('session-123');
  });

  it('calls openSession with the resolved datasource', async () => {
    const ctx = contextWith(fakePlugin());
    const openSession = vi.fn<(datasource: DatasourceProfile) => string>(() => 'session-abc');
    await executeQuery(queryRequest(), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver, openSession });
    expect(openSession).toHaveBeenCalledOnce();
    expect(openSession.mock.calls[0]?.[0]).toMatchObject({ name: 'qa-fake', kind: 'fake' });
  });

  it('omits the session marker when no session is opened', async () => {
    const capture: { creds?: Record<string, string> } = {};
    const ctx = contextWith(capturingPlugin(capture));
    await executeQuery(queryRequest(), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined, resolveDatasource: storeResolver });
    expect(capture.creds?.[SESSION_ID_KEY]).toBeUndefined();
  });
});
