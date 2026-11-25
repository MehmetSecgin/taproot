import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { outputData } from './helpers/cli-contract-envelopes.js';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';

function setupState(): { env: Record<string, string> } {
  const { stateRoot, configDir } = tempStateRoot();
  fs.writeFileSync(
    path.join(configDir, 'deterministic-config.json'),
    JSON.stringify({
      environmentPolicies: {
        careful: {
          deterministicRequired: true,
          allowDiscoveryByDefault: false,
          preferredAccessMethods: ['tsh'],
          targetPreference: ['tidb', 'mysql'],
        },
      },
      serviceAliases: {
        legacyservice: 'sample-service',
      },
    }),
  );
  const kbDir = path.join(stateRoot, 'kb');
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(
    path.join(kbDir, 'services.json'),
    JSON.stringify([
      { service: 'orders', connections: [] },
      { service: 'sample-service', connections: [] },
    ]),
  );
  return {
    env: {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_KB_DIR: kbDir,
    },
  };
}

const serviceNamesSchema = z.array(z.string());

describe('runtime policy and KB state', () => {

  it('lists KB services', () => {
    const { env } = setupState();
    const out = runCli(['kb', 'list-services'], env);
    expect(out.status).toBe(0);
    expect(outputData(out.stdout, serviceNamesSchema)).toStrictEqual(['orders', 'sample-service']);
  });
});
