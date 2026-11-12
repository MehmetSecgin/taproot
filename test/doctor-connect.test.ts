import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';

describe('doctor --connect', () => {
  it('checks connector status after connect, so a forward it just started is not a warning', () => {
    // arrange
    const { stateRoot, configDir } = tempStateRoot();
    const marker = path.join(stateRoot, 'forward-up');
    fs.writeFileSync(
      path.join(configDir, 'datasources.json'),
      JSON.stringify([
        {
          name: 'qa-demo',
          kind: 'mysql',
          env: 'qa',
          service: 'demo',
          tags: [],
          connection: { host: '127.0.0.1', port: 1, database: 'demo' },
          credentialRef: 'qa:demo',
          connectors: ['kubectl-portforward'],
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          resolverHints: { 'kubectl-portforwardCredentialRef': 'qa:demo-forward' },
          updatedAt: new Date().toISOString(),
          confidence: 0.9,
        },
      ]),
    );
    fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');
    const env = { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key' };
    const seed = runCli(
      ['creds', 'set', '--ref', 'qa:demo-forward', '--status-command', `test -f '${marker}'`, '--connect-command', `touch '${marker}'`],
      env,
    );
    expect(seed.status).toBe(0);

    // act
    const out = runCli(['doctor', '--datasource', 'qa-demo', '--connect'], env);

    // assert
    const checks: Array<{ check: string; status: string }> = JSON.parse(out.stdout).data.checks;
    expect(checks.slice(0, 2)).toEqual([
      expect.objectContaining({ check: 'kubectl-portforward connect', status: 'ok' }),
      expect.objectContaining({ check: 'kubectl-portforward status', status: 'ok' }),
    ]);
  });
});
