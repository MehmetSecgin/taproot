import path from 'node:path';
import { CredentialStore } from '../../src/store/credentials.js';
import { DatasourceStore } from '../../src/store/datasources.js';
import type { DaemonInstance } from '../../src/daemon/server.js';
import type { TapRootPlugin } from '../../src/types/plugin.js';
import { startLocalDaemon } from './daemon.js';
import { tempStateRoot } from './state-root.js';

export async function startDaemonWithFakeDatasources(datasourceCount: number, plugin: TapRootPlugin): Promise<{ daemon: DaemonInstance; socketPath: string }> {
  const { stateRoot, configDir } = tempStateRoot();
  process.env.TAPROOT_STATE_ROOT = stateRoot;
  process.env.TAPROOT_MASTER_KEY = 'test-master-key';
  process.env.NODE_ENV = 'test';

  const datasourceStore = new DatasourceStore(path.join(configDir, 'datasources.json'));
  for (let index = 0; index < datasourceCount; index += 1) {
    datasourceStore.save({
      name: `qa-fake-${index}`,
      kind: 'fake',
      env: 'qa',
      service: `fake-${index}`,
      tags: [],
      connection: { host: '127.0.0.1', port: 1, database: 'fake' },
      credentialRef: 'qa:fake',
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      updatedAt: new Date().toISOString(),
    });
  }
  const credentials = new CredentialStore(path.join(configDir, 'credentials.json.enc'), true);
  await credentials.set('qa:fake', { user: 'x', password: 'x' });

  const socketPath = path.join(stateRoot, 'run', 'taprootd-test.sock');
  const daemon = await startLocalDaemon({ stateRoot, socketPath, plugins: [plugin] });
  return { daemon, socketPath };
}
