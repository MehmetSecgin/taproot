import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';

function connection(target: string) {
  return {
    env: 'qa',
    namespace: 'develop',
    engine: 'mysql',
    database: target,
    db_user: 'reader',
    access_method: 'kubectl-portforward',
    k8s_context: 'cluster-ctx',
    target,
    status: 'active',
    verified_at_utc: '2026-03-01T00:00:00Z',
  };
}

function setupState() {
  const { stateRoot } = tempStateRoot();
  const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-kubectl-portforward-kb-'));
  fs.writeFileSync(
    path.join(kbDir, 'services.json'),
    JSON.stringify([
      { service: 'profile', connections: [connection('profile-db')] },
      { service: 'address', connections: [connection('address-db')] },
    ]),
  );
  return {
    stateRoot,
    env: {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_NO_KEYCHAIN: '1',
      TAPROOT_FORCE_DIRECT: '1',
      TAPROOT_KB_DIR: kbDir,
    },
  };
}

function savedPort(stateRoot: string, service: string): number {
  const datasources = JSON.parse(fs.readFileSync(path.join(stateRoot, 'config', 'datasources.json'), 'utf8'));
  return datasources.find((d: { service: string }) => d.service === service).connection.port;
}

const listeners: Array<ReturnType<typeof spawn>> = [];

afterEach(() => {
  for (const listener of listeners.splice(0)) listener.kill();
});

async function fakeForward(port: number, forwardArgs: string): Promise<void> {
  const script = `require('net').createServer((s) => s.destroy()).listen(${port}, '127.0.0.1', () => console.log('up'))`;
  const listener = spawn(process.execPath, ['-e', script, '--', ...forwardArgs.split(' ')], { stdio: ['ignore', 'pipe', 'inherit'] });
  listeners.push(listener);
  await new Promise((resolve) => listener.stdout!.once('data', resolve));
}

function portforwardStatus(service: string, env: Record<string, string>): string {
  const out = runCli(['doctor', '--env', 'qa', '--service', service], env);
  const checks: Array<{ check: string; status: string }> = JSON.parse(out.stdout).data.checks;
  return checks.find((c) => c.check === 'kubectl-portforward status')!.status;
}

describe('kubectl-portforward profiles', () => {
  it('give two services in one env different local ports', () => {
    // arrange
    const { stateRoot, env } = setupState();

    // act
    runCli(['init', 'datasource', '--env', 'qa', '--service', 'profile'], env);
    runCli(['init', 'datasource', '--env', 'qa', '--service', 'address'], env);

    // assert
    expect(savedPort(stateRoot, 'profile')).not.toBe(savedPort(stateRoot, 'address'));
  });

  it('count a listener as up only when it forwards their own target', async () => {
    // arrange
    const { stateRoot, env } = setupState();
    expect(runCli(['init', 'datasource', '--env', 'qa', '--service', 'profile'], env).status).toBe(0);
    expect(runCli(['init', 'datasource', '--env', 'qa', '--service', 'address'], env).status).toBe(0);
    const profilePort = savedPort(stateRoot, 'profile');
    const addressPort = savedPort(stateRoot, 'address');
    await fakeForward(profilePort, `--context cluster-ctx -n develop port-forward svc/profile-db ${profilePort}:4000`);
    await fakeForward(addressPort, `--context cluster-ctx -n develop port-forward svc/profile-db ${addressPort}:4000`);

    // act
    const profileStatus = portforwardStatus('profile', env);
    const addressStatus = portforwardStatus('address', env);

    // assert
    expect(profileStatus).toBe('ok');
    expect(addressStatus).toBe('warn');
  });
});
