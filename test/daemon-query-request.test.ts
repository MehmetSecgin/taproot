import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { executeQuery } from '../src/core/execute-query.js';
import { rpcCall } from '../src/daemon/client.js';
import { startLocalDaemon } from './helpers/daemon.js';
import { fakePlugin } from './helpers/fake-plugin.js';
import { queryRequest, restoreProcessEnv, setupQueryState } from './helpers/query-state.js';

vi.mock(import('../src/core/execute-query.js'), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, executeQuery: vi.fn<typeof actual.executeQuery>(actual.executeQuery) };
});

describe('daemon query request', () => {
  afterEach(restoreProcessEnv);

  it('passes every request field through to the query and opens the session on the resolved datasource', async () => {
    // arrange
    const stateRoot = await setupQueryState();
    const socketPath = path.join(stateRoot, 'run', 'taprootd-request.sock');
    const daemon = await startLocalDaemon({ stateRoot, socketPath, plugins: [fakePlugin()] });

    try {
      // act
      const res = await rpcCall({
        socketPath,
        method: 'query.execute',
        params: { ...queryRequest({ rowsObject: true }), fieldTheDaemonDoesNotKnow: 'kept' },
      });

      // assert
      expect(res).toMatchObject({ ok: true });
      expect(res.meta?.sessionId).toMatch(/^sess_/u);
      expect(vi.mocked(executeQuery).mock.calls[0][0]).toMatchObject({
        datasource: 'qa-fake',
        rowsObject: true,
        timeoutMs: 5000,
        fieldTheDaemonDoesNotKnow: 'kept',
      });
    } finally {
      await daemon.stop();
    }
  });
});
