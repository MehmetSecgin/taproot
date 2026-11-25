import path from 'node:path';
import type { DaemonInstance } from '../../src/daemon/server.js';
import { DatasourceStore } from '../../src/store/datasources.js';
import { tlsPort } from './daemon.js';
import { startTlsDaemon } from './tls-daemon.js';
import { fakePlugin } from './fake-plugin.js';
import { createTestPki } from './mutual-tls.js';
import { setupQueryState } from './query-state.js';

export type RemoteCliDaemon = {
  daemon: DaemonInstance;
  cliEnv: Record<string, string>;
};

export async function startRemoteCliDaemon(): Promise<RemoteCliDaemon> {
  const pki = createTestPki();
  const stateRoot = await setupQueryState({ kind: 'mysql' });
  const datasources = new DatasourceStore(path.join(stateRoot, 'config', 'datasources.json'));
  const served = datasources.get('qa-fake');
  if (served === undefined) {
    throw new Error('qa-fake was not seeded');
  }
  datasources.save({ ...served, name: 'qa-closed' });
  const plugin = fakePlugin({ kind: 'mysql', columns: ['table_name', 'column_name'], rows: [['orders', 'id']] });
  const daemon = await startTlsDaemon({
    plugins: [plugin],
    tls: pki.daemon,
    checkDatasource: async ({ datasource }) => {
      if (datasource.name === 'qa-closed') {
        throw new Error("'qa-closed' is not served here.");
      }
      await Promise.resolve();
    },
  });
  const cliEnv = {
    TEST_DAEMON_HOST: '127.0.0.1',
    TEST_DAEMON_PORT: String(tlsPort(daemon)),
    TEST_TLS_CA: pki.client.caFile,
    TEST_TLS_CERT: pki.client.certFile,
    TEST_TLS_KEY: pki.client.keyFile,
  };
  return { daemon, cliEnv };
}
