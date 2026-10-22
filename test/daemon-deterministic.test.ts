import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rpcCall } from '../src/daemon/client.js';
import { startDaemon } from '../src/daemon/server.js';
import { CredentialStore } from '../src/store/credentials.js';
import { fakePlugin } from './helpers/fake-plugin.js';

const previousEnv = {
  TAPROOT_STATE_ROOT: process.env.TAPROOT_STATE_ROOT,
  TAPROOT_MASTER_KEY: process.env.TAPROOT_MASTER_KEY,
  NODE_ENV: process.env.NODE_ENV,
};

function makeStateRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'trd-'));
}

function writeRuntimeConfig(stateRoot: string, config: Record<string, unknown>): void {
  const configDir = path.join(stateRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(configDir, 'deterministic-config.json'), JSON.stringify(config));
}

afterEach(() => {
  process.env.TAPROOT_STATE_ROOT = previousEnv.TAPROOT_STATE_ROOT;
  process.env.TAPROOT_MASTER_KEY = previousEnv.TAPROOT_MASTER_KEY;
  process.env.NODE_ENV = previousEnv.NODE_ENV;
});

describe('daemon deterministic resolution', () => {
  it('returns DETERMINISTIC_REQUIRED in prod when datasource is unresolved', async () => {
    const stateRoot = makeStateRoot();
    writeRuntimeConfig(stateRoot, {
      environmentPolicies: {
        prod: {
          deterministicRequired: true,
          allowDiscoveryByDefault: false,
        },
      },
    });
    process.env.TAPROOT_STATE_ROOT = stateRoot;
    process.env.TAPROOT_MASTER_KEY = 'test-master-key';
    const socketPath = path.join(stateRoot, 'run', 'taprootd-test.sock');
    const daemon = await startDaemon({ stateRoot, socketPath });
    try {
      const res = await rpcCall({
        socketPath,
        method: 'query.execute',
        params: {
          env: 'prod',
          service: 'missing',
          query: 'SELECT 1 AS ok',
        },
      });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('DETERMINISTIC_REQUIRED');
    } finally {
      await daemon.stop();
    }
  });

  it('returns DISCOVERY_UNAVAILABLE in daemon path when allowDiscovery is requested', async () => {
    const stateRoot = makeStateRoot();
    writeRuntimeConfig(stateRoot, {
      environmentPolicies: {
        prod: {
          deterministicRequired: true,
          allowDiscoveryByDefault: false,
        },
      },
    });
    process.env.TAPROOT_STATE_ROOT = stateRoot;
    process.env.TAPROOT_MASTER_KEY = 'test-master-key';
    const socketPath = path.join(stateRoot, 'run', 'taprootd-test.sock');
    const daemon = await startDaemon({ stateRoot, socketPath });
    try {
      const res = await rpcCall({
        socketPath,
        method: 'query.execute',
        params: {
          env: 'prod',
          service: 'missing',
          allowDiscovery: true,
          query: 'SELECT 1 AS ok',
        },
      });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('DISCOVERY_UNAVAILABLE');
    } finally {
      await daemon.stop();
    }
  });

  it('returns QUERY_TIMEOUT when execution exceeds timeoutMs', async () => {
    const stateRoot = makeStateRoot();
    writeRuntimeConfig(stateRoot, {});
    process.env.TAPROOT_STATE_ROOT = stateRoot;
    process.env.TAPROOT_MASTER_KEY = 'test-master-key';
    process.env.NODE_ENV = 'test';
    const configDir = path.join(stateRoot, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'datasources.json'),
      JSON.stringify([
        {
          name: 'qa-slow',
          kind: 'fake',
          env: 'qa',
          service: 'slow',
          tags: [],
          connection: { host: '127.0.0.1', port: 1, database: 'slow' },
          credentialRef: 'qa:slow',
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          updatedAt: new Date().toISOString(),
          confidence: 1,
        },
      ]),
    );
    const creds = new CredentialStore(path.join(configDir, 'credentials.json.enc'));
    await creds.set('qa:slow', { user: 'reader', password: 'secret' });
    const socketPath = path.join(stateRoot, 'run', 'taprootd-test.sock');
    const daemon = await startDaemon({
      stateRoot,
      socketPath,
      configurePlugins: (registry) => registry.set('fake', fakePlugin({ holdMs: 100 })),
    });
    try {
      const res = await rpcCall({
        socketPath,
        method: 'query.execute',
        params: {
          datasource: 'qa-slow',
          query: 'SELECT 1 AS ok',
          timeoutMs: 25,
        },
        timeoutMs: 5_000,
      });
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe('QUERY_TIMEOUT');
    } finally {
      await daemon.stop();
    }
  });
});
