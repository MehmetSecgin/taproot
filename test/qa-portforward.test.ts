import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';

function runCli(args: string[], env: Record<string, string> = {}) {
  const distCli = path.join(process.cwd(), 'dist', 'index.js');
  return spawnSync(process.execPath, [distCli, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function connection(target: string) {
  return {
    env: 'qa',
    namespace: 'develop',
    engine: 'mysql',
    database: target,
    db_user: 'reader',
    access_method: 'qa-portforward',
    target,
    status: 'active',
    verified_at_utc: '2026-03-01T00:00:00Z',
  };
}

function setupState(extraEnv: Record<string, string> = {}) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-qa-portforward-'));
  const kbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-qa-portforward-kb-'));
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
      TAPROOT_QA_CONTEXT: 'qa-ctx',
      TAPROOT_QA_LOCAL_PORT: '',
      ...extraEnv,
    },
  };
}

function savedPort(stateRoot: string, service: string): number {
  const datasources = JSON.parse(fs.readFileSync(path.join(stateRoot, 'config', 'datasources.json'), 'utf8'));
  return datasources.find((d: { service: string }) => d.service === service).connection.port;
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as net.AddressInfo;
  await new Promise((resolve) => server.close(resolve));
  return port;
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

describe('qa-portforward profiles', () => {
  it('give two services in one env different local ports', () => {
    // arrange
    const { stateRoot, env } = setupState();

    // act
    runCli(['init', 'datasource', '--env', 'qa', '--service', 'profile'], env);
    runCli(['init', 'datasource', '--env', 'qa', '--service', 'address'], env);

    // assert
    expect(savedPort(stateRoot, 'profile')).not.toBe(savedPort(stateRoot, 'address'));
  });

  it('do not accept another service forward listening on a shared port as up', async () => {
    // arrange
    const port = await freePort();
    const { env } = setupState({ TAPROOT_QA_LOCAL_PORT: String(port) });
    expect(runCli(['init', 'datasource', '--env', 'qa', '--service', 'profile'], env).status).toBe(0);
    expect(runCli(['init', 'datasource', '--env', 'qa', '--service', 'address'], env).status).toBe(0);
    await fakeForward(port, `--context qa-ctx -n develop port-forward svc/profile-db ${port}:4000`);

    // act
    const profileStatus = portforwardStatus('profile', env);
    const addressStatus = portforwardStatus('address', env);

    // assert
    expect(profileStatus).toBe('ok');
    expect(addressStatus).toBe('warn');
  });
});
