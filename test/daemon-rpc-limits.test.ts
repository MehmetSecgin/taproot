import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_CONSTANTS } from '../src/core/constants.js';
import { TAPROOT_VERSION } from '../src/core/version.js';
import { rpcCall } from '../src/daemon/client.js';
import type { QueryResult, TapRootPlugin } from '../src/types/plugin.js';
import { startDaemonWithFakeDatasources } from './helpers/fake-datasource-daemon.js';
import { restoreProcessEnv } from './helpers/query-state.js';
import { fakePlugin } from './helpers/fake-plugin.js';
import { waitMs } from '../src/core/wait.js';

type FakeQuery = {
  socketPath: string;
  datasourceIndex: number;
  queryTimeoutMs?: number;
  replyTimeoutMs: number;
};

function rangeOf(count: number): number[] {
  return Array.from({ length: count }, (_ignored, index) => index);
}

async function queryFakeDatasource(query: FakeQuery): ReturnType<typeof rpcCall> {
  return rpcCall({
    socketPath: query.socketPath,
    method: 'query.execute',
    params: {
      datasource: `qa-fake-${query.datasourceIndex}`,
      query: 'SELECT 1 AS ok',
      ...(query.queryTimeoutMs === undefined ? {} : { timeoutMs: query.queryTimeoutMs }),
    },
    timeoutMs: query.replyTimeoutMs,
  });
}

function abortWatchingPlugin(seen: { executing: boolean; abortReason?: unknown }): TapRootPlugin {
  const plugin = fakePlugin();
  plugin.execute = async (request): Promise<QueryResult> => {
    seen.executing = true;
    return new Promise((_resolve, reject) => {
      request.signal?.addEventListener('abort', () => {
        const reason: unknown = request.signal?.reason;
        seen.abortReason = reason;
        reject(reason instanceof Error ? reason : new Error(String(reason)));
      });
    });
  };
  return plugin;
}

async function sendQueryAndHangUp(socketPath: string, seen: { executing: boolean }): Promise<void> {
  const socket = net.createConnection(socketPath);
  socket.write(
    `${JSON.stringify({
      protocolVersion: RUNTIME_CONSTANTS.protocolVersion,
      clientVersion: TAPROOT_VERSION,
      requestId: 'gone-agent',
      method: 'query.execute',
      params: { datasource: 'qa-fake-0', query: 'SELECT 1 AS ok' },
    })}\n`,
  );
  await vi.waitFor(() => {
    expect(seen.executing).toBe(true);
  });
  socket.destroy();
}

describe('daemon rpc limits', () => {
  afterEach(restoreProcessEnv);

  it('returns OVERLOADED when queue limit is exceeded', async () => {
    const total =
      RUNTIME_CONSTANTS.daemon.maxConcurrentQueries + RUNTIME_CONSTANTS.daemon.maxQueuedQueries + 1;
    const { daemon, socketPath } = await startDaemonWithFakeDatasources(total, fakePlugin({ holdMs: 900 }));
    try {
      const calls = rangeOf(total).map(async (datasourceIndex) => queryFakeDatasource({ socketPath, datasourceIndex, replyTimeoutMs: 15_000 }));
      const replies = await Promise.all(calls);
      const overloaded = replies.filter((reply) => reply.error?.code === 'OVERLOADED');
      expect(overloaded.length).toBeGreaterThan(0);
      expect(overloaded[0].error?.message).toContain('queue');
    } finally {
      await daemon.stop();
    }
  }, 15_000);

  it('runs 8 parallel queries on one datasource without rejecting any', async () => {
    const { daemon, socketPath } = await startDaemonWithFakeDatasources(1, fakePlugin({ holdMs: 500 }));
    try {
      const calls = rangeOf(8).map(async () => queryFakeDatasource({ socketPath, datasourceIndex: 0, replyTimeoutMs: 10_000 }));
      const replies = await Promise.all(calls);
      expect(replies.map((reply) => reply.ok)).toStrictEqual(rangeOf(8).map(() => true));
    } finally {
      await daemon.stop();
    }
  });

  it('reports limiter stats and limits in daemon.status', async () => {
    const { daemon, socketPath } = await startDaemonWithFakeDatasources(1, fakePlugin());
    try {
      const res = await rpcCall({ socketPath, method: 'daemon.status' });
      expect(res.ok).toBe(true);
      expect(res.data?.queryLimiter).toBeDefined();
      expect(res.data?.limits).toMatchObject({
        maxConcurrentQueries: RUNTIME_CONSTANTS.daemon.maxConcurrentQueries,
        maxQueuedQueries: RUNTIME_CONSTANTS.daemon.maxQueuedQueries,
      });
    } finally {
      await daemon.stop();
    }
  });

  it('counts queue wait time against timeoutMs', async () => {
    const total = RUNTIME_CONSTANTS.daemon.maxConcurrentQueries + 1;
    const { daemon, socketPath } = await startDaemonWithFakeDatasources(total, fakePlugin({ holdMs: 900 }));
    try {
      const blockers = rangeOf(RUNTIME_CONSTANTS.daemon.maxConcurrentQueries).map(async (datasourceIndex) =>
        queryFakeDatasource({ socketPath, datasourceIndex, queryTimeoutMs: 5000, replyTimeoutMs: 10_000 }),
      );
      await waitMs(100);

      const startedAt = Date.now();
      const queued = await queryFakeDatasource({
        socketPath,
        datasourceIndex: RUNTIME_CONSTANTS.daemon.maxConcurrentQueries,
        queryTimeoutMs: 200,
        replyTimeoutMs: 10_000,
      });
      const elapsedMs = Date.now() - startedAt;

      expect(queued.ok).toBe(false);
      expect(queued.error?.code).toBe('QUERY_TIMEOUT');
      expect(elapsedMs).toBeLessThan(800);

      await Promise.all(blockers);
    } finally {
      await daemon.stop();
    }
  });

  it('aborts the in-flight query and frees its slot when the client disconnects', async () => {
    // arrange
    const seen: { executing: boolean; abortReason?: unknown } = { executing: false };
    const { daemon, socketPath } = await startDaemonWithFakeDatasources(1, abortWatchingPlugin(seen));
    try {
      // act
      await sendQueryAndHangUp(socketPath, seen);

      // assert
      await vi.waitFor(() => {
        expect(String(seen.abortReason)).toContain('client disconnected');
      });
      const status = await rpcCall({ socketPath, method: 'daemon.status' });
      expect(status.data?.queryLimiter).toMatchObject({ inFlight: 0 });
    } finally {
      await daemon.stop();
    }
  });
});
