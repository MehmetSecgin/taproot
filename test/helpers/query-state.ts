import path from 'node:path';
import { buildContext } from '../../src/core/app.js';
import type { AppContext } from '../../src/core/app.js';
import type { QueryExecutionRequest } from '../../src/core/execute-query.js';
import { CredentialStore } from '../../src/store/credentials.js';
import { DatasourceStore } from '../../src/store/datasources.js';
import type { DatasourceProfile, TapRootPlugin } from '../../src/types/core.js';
import { tempStateRoot } from './state-root.js';

const savedEnv = {
  TAPROOT_STATE_ROOT: process.env.TAPROOT_STATE_ROOT,
  TAPROOT_MASTER_KEY: process.env.TAPROOT_MASTER_KEY,
  NODE_ENV: process.env.NODE_ENV,
};

export async function setupQueryState(overrides: Partial<DatasourceProfile> = {}): Promise<string> {
  const { stateRoot, configDir } = tempStateRoot();
  process.env.TAPROOT_STATE_ROOT = stateRoot;
  process.env.TAPROOT_MASTER_KEY = 'test-master-key';
  process.env.NODE_ENV = 'test';
  const dsStore = new DatasourceStore(path.join(configDir, 'datasources.json'));
  dsStore.save({
    name: 'qa-fake',
    kind: 'fake',
    env: 'qa',
    service: 'fake',
    tags: [],
    connection: { host: '127.0.0.1', port: 1, database: 'fake' },
    credentialRef: 'qa:fake',
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    updatedAt: new Date().toISOString(),
    confidence: 1,
    ...overrides,
  } as DatasourceProfile);
  const creds = new CredentialStore(path.join(configDir, 'credentials.json.enc'));
  await creds.set('qa:fake', { user: 'x', password: 'x' });
  return stateRoot;
}

export function restoreQueryEnv(): void {
  process.env.TAPROOT_STATE_ROOT = savedEnv.TAPROOT_STATE_ROOT;
  process.env.TAPROOT_MASTER_KEY = savedEnv.TAPROOT_MASTER_KEY;
  process.env.NODE_ENV = savedEnv.NODE_ENV;
}

export function contextWith(plugin: TapRootPlugin): AppContext {
  const ctx = buildContext({});
  ctx.pluginRegistry.set(plugin.manifest.name, plugin);
  return ctx;
}

export function queryRequest(overrides: Partial<QueryExecutionRequest> = {}): QueryExecutionRequest {
  return {
    datasource: 'qa-fake',
    env: 'qa',
    namespace: '',
    service: 'fake',
    query: 'SELECT 1 AS ok',
    params: [],
    allowDiscovery: false,
    allowMutate: false,
    allowPartitionScan: false,
    explain: false,
    rowsObject: false,
    jsonExtract: [],
    allowFlush: false,
    skipProtoValidate: false,
    timeoutMs: 5_000,
    ...overrides,
  };
}
