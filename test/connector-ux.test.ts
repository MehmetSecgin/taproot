import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';

function setupStateRoot() {
  const { stateRoot, configDir } = tempStateRoot();
  fs.writeFileSync(
    path.join(configDir, 'datasources.json'),
    JSON.stringify([
      {
        name: 'qa-demo',
        kind: 'mysql',
        env: 'qa',
        service: 'demo',
        tags: [],
        connection: { host: '127.0.0.1', port: 3306, database: 'demo' },
        credentialRef: 'qa:demo',
        connectors: ['kubectl-portforward'],
        policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
        resolverHints: { 'kubectl-portforwardCredentialRef': 'kpf:qa:demo' },
        updatedAt: new Date().toISOString(),
        confidence: 0.9,
      },
    ]),
  );
  return {
    stateRoot,
    env: {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-master-key',
    },
  };
}

describe('connector UX', () => {

  it('doctor reports the missing connector command as a coded check', () => {
    const { stateRoot, configDir } = tempStateRoot();
    fs.writeFileSync(
      path.join(configDir, 'datasources.json'),
      JSON.stringify([
        {
          name: 'qa-kpf',
          kind: 'mysql',
          env: 'qa',
          service: 'demo',
          tags: [],
          connection: { host: '127.0.0.1', port: 3306, database: 'demo' },
          credentialRef: 'qa:demo',
          connectors: ['kubectl-portforward'],
          resolverHints: {},
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          updatedAt: new Date().toISOString(),
          confidence: 0.9,
        },
      ]),
    );
    const out = runCli(['doctor', '--datasource', 'qa-kpf'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-master-key',
    });
    expect(out.status).not.toBe(0);
    const parsed = JSON.parse(out.stdout).data;
    expect(parsed.checks).toContainEqual(
      expect.objectContaining({ check: 'kubectl-portforward status', code: 'connector_status_command_missing' }),
    );
  });

  it('doctor returns machine-readable connector codes for blocked status checks', () => {
    const { env } = setupStateRoot();
    expect(runCli(['creds', 'set', '--ref', 'kpf:qa:demo', '--status-command', 'false', '--connect-command', 'true'], env).status).toBe(0);
    const out = runCli(['doctor', '--datasource', 'qa-demo'], env);
    expect(out.status).not.toBe(0);
    const parsed = JSON.parse(out.stdout).data;
    expect(parsed.checks.find((check: { check: string }) => check.check === 'kubectl-portforward status')?.code).toBe('connector_status_blocked');
  });
});
