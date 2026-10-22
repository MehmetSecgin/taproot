import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RUNTIME_CONSTANTS } from '../src/core/constants.js';
import { rpcCall } from '../src/daemon/client.js';
import { startDaemon } from '../src/daemon/server.js';
import { CredentialStore } from '../src/store/credentials.js';
import { fakePlugin } from './helpers/fake-plugin.js';
import { DatasourceStore } from '../src/store/datasources.js';

const previousEnv = {
  TAPROOT_STATE_ROOT: process.env.TAPROOT_STATE_ROOT,
  TAPROOT_MASTER_KEY: process.env.TAPROOT_MASTER_KEY,
  NODE_ENV: process.env.NODE_ENV,
};

function makeStateRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-daemon-'));
}

async function setupDaemon(datasourceCount = 1, holdMs = 0) {
  const stateRoot = makeStateRoot();
  process.env.TAPROOT_STATE_ROOT = stateRoot;
  process.env.TAPROOT_MASTER_KEY = 'test-master-key';
  process.env.NODE_ENV = 'test';

  const configDir = path.join(stateRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const dsStore = new DatasourceStore(path.join(configDir, 'datasources.json'));
  for (let i = 0; i < datasourceCount; i += 1) {
    dsStore.save({
      name: `qa-fake-${i}`,
      kind: 'fake',
      env: 'qa',
      service: `fake-${i}`,
      tags: [],
      connection: { host: '127.0.0.1', port: 1, database: 'fake' },
      credentialRef: 'qa:fake',
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      updatedAt: new Date().toISOString(),
      confidence: 1,
    });
  }
  const creds = new CredentialStore(path.join(configDir, 'credentials.json.enc'));
  await creds.set('qa:fake', { user: 'x', password: 'x' });

  const socketPath = path.join(stateRoot, 'run', 'taprootd-test.sock');
  const daemon = await startDaemon({
    stateRoot,
    socketPath,
    configurePlugins: (registry) => registry.set('fake', fakePlugin({ holdMs })),
  });
  return { daemon, socketPath };
}

afterEach(() => {
  process.env.TAPROOT_STATE_ROOT = previousEnv.TAPROOT_STATE_ROOT;
  process.env.TAPROOT_MASTER_KEY = previousEnv.TAPROOT_MASTER_KEY;
  process.env.NODE_ENV = previousEnv.NODE_ENV;
});

describe('daemon rpc limits', () => {
  it('returns OVERLOADED when queue limit is exceeded', async () => {
    const total =
      RUNTIME_CONSTANTS.daemon.maxConcurrentQueries + RUNTIME_CONSTANTS.daemon.maxQueuedQueries + 1;
    const { daemon, socketPath } = await setupDaemon(total, 900);
    try {
      const calls = Array.from({ length: total }, (_, i) =>
        rpcCall({
          socketPath,
          method: 'query.execute',
          params: {
            datasource: `qa-fake-${i}`,
            query: 'SELECT 1 AS ok',
          },
          timeoutMs: 15_000,
        }),
      );
      const out = await Promise.all(calls);
      const overloaded = out.filter((r) => !r.ok && r.error?.code === 'OVERLOADED');
      expect(overloaded.length).toBeGreaterThan(0);
      expect(overloaded[0].error?.message).toContain('queue');
    } finally {
      await daemon.stop();
    }
  }, 15_000);

  it('returns SESSION_BUSY when per-session lease cap is exceeded', async () => {
    const { daemon, socketPath } = await setupDaemon(1, 500);
    try {
      const total = RUNTIME_CONSTANTS.session.maxConcurrentLeases + 1;
      const calls = Array.from({ length: total }, () =>
        rpcCall({
          socketPath,
          method: 'query.execute',
          params: {
            datasource: 'qa-fake-0',
            query: 'SELECT 1 AS ok',
          },
          timeoutMs: 10_000,
        }),
      );
      const out = await Promise.all(calls);
      const busy = out.filter((r) => !r.ok && r.error?.code === 'SESSION_BUSY');
      expect(busy.length).toBeGreaterThan(0);
    } finally {
      await daemon.stop();
    }
  });

  it('reports limiter stats and limits in daemon.status', async () => {
    const { daemon, socketPath } = await setupDaemon(1);
    try {
      const res = await rpcCall({ socketPath, method: 'daemon.status' });
      expect(res.ok).toBe(true);
      expect(res.data?.queryLimiter).toBeDefined();
      expect(res.data?.limits).toMatchObject({
        maxConcurrentQueries: RUNTIME_CONSTANTS.daemon.maxConcurrentQueries,
        maxQueuedQueries: RUNTIME_CONSTANTS.daemon.maxQueuedQueries,
        maxConcurrentLeases: RUNTIME_CONSTANTS.session.maxConcurrentLeases,
      });
    } finally {
      await daemon.stop();
    }
  });

  it('counts queue wait time against timeoutMs', async () => {
    const total = RUNTIME_CONSTANTS.daemon.maxConcurrentQueries + 1;
    const { daemon, socketPath } = await setupDaemon(total, 900);
    try {
      const blockers = Array.from({ length: RUNTIME_CONSTANTS.daemon.maxConcurrentQueries }, (_, i) =>
        rpcCall({
          socketPath,
          method: 'query.execute',
          params: {
            datasource: `qa-fake-${i}`,
            query: 'SELECT 1 AS ok',
            timeoutMs: 5_000,
          },
          timeoutMs: 10_000,
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 100));

      const startedAt = Date.now();
      const queued = await rpcCall({
        socketPath,
        method: 'query.execute',
        params: {
          datasource: `qa-fake-${RUNTIME_CONSTANTS.daemon.maxConcurrentQueries}`,
          query: 'SELECT 1 AS ok',
          timeoutMs: 200,
        },
        timeoutMs: 10_000,
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
});
