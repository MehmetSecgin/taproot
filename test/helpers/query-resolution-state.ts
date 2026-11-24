import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { tempStateRoot } from './state-root.js';

export function setupState(input?: {
  runtimeConfig?: Record<string, unknown>;
  datasources?: Record<string, unknown>[];
  kbServices?: Record<string, unknown>[];
}): { stateRoot: string; env: Record<string, string> } {
  const { stateRoot, configDir } = tempStateRoot();
  fs.writeFileSync(
    path.join(configDir, 'datasources.json'),
    JSON.stringify(
      input?.datasources ?? [
        {
          name: 'qa-orders',
          kind: 'mysql',
          env: 'qa',
          service: 'orders',
          tags: [],
          connection: { host: '127.0.0.1', port: 1, database: 'orders' },
          credentialRef: 'qa:orders',
          connectors: [],
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          resolverHints: {},
          updatedAt: new Date().toISOString(),
        },
      ],
    ),
  );
  fs.writeFileSync(path.join(configDir, 'deterministic-config.json'), JSON.stringify(input?.runtimeConfig ?? {}));
  const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-query-resolution-kb-'));
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'services.json'), JSON.stringify(input?.kbServices ?? []));
  return {
    stateRoot,
    env: {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_FORCE_DIRECT: '1',
      TAPROOT_KB_DIR: kbDir,
    },
  };
}
