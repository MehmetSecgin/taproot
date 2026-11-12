import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeQuery } from '../src/core/execute-query.js';
import { rpcCall } from '../src/daemon/client.js';
import { startDaemon } from '../src/daemon/server.js';
import { fakePlugin } from './helpers/fake-plugin.js';
import { queryRequest, restoreQueryEnv, setupQueryState } from './helpers/query-state.js';

vi.mock('../src/core/execute-query.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/execute-query.js')>();
  return { ...actual, executeQuery: vi.fn(actual.executeQuery) };
});

afterEach(restoreQueryEnv);

describe('daemon query request', () => {
  it('passes every request field through to the query and opens the session on the resolved datasource', async () => {
    // arrange
    const stateRoot = await setupQueryState();
    const socketPath = path.join(stateRoot, 'run', 'taprootd-request.sock');
    const daemon = await startDaemon({ stateRoot, socketPath, configurePlugins: (registry) => registry.set('fake', fakePlugin()) });

    try {
      // act
      const res = await rpcCall({
        socketPath,
        method: 'query.execute',
        params: { ...queryRequest({ rowsObject: true }), fieldTheDaemonDoesNotKnow: 'kept' },
      });

      // assert
      expect(res.ok).toBe(true);
      expect(res.meta?.sessionId).toMatch(/^sess_/);
      expect(vi.mocked(executeQuery).mock.calls[0][0]).toMatchObject({
        datasource: 'qa-fake',
        rowsObject: true,
        timeoutMs: 5_000,
        fieldTheDaemonDoesNotKnow: 'kept',
      });
    } finally {
      await daemon.stop();
    }
  });
});
