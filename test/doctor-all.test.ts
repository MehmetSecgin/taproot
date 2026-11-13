import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import { describe, expect, it } from 'vitest';
import { probeTcp, selectDatasources, tcpStatusOf } from '../src/core/doctor-all.js';
import type { DatasourceProfile } from '../src/types/core.js';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';
import { stubRedisCli } from './helpers/redis-cli-stub.js';

function profile(name: string, env: string, kind: string, port: number, extra: Partial<DatasourceProfile> = {}): DatasourceProfile {
  return {
    name,
    kind,
    env,
    tags: [],
    connection: { host: '127.0.0.1', port },
    credentialRef: name,
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    updatedAt: new Date().toISOString(),
    confidence: 0.9,
    ...extra,
  };
}

function stateWith(profiles: DatasourceProfile[]): Record<string, string> {
  const { stateRoot, configDir } = tempStateRoot();
  fs.writeFileSync(path.join(configDir, 'datasources.json'), JSON.stringify(profiles));
  fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');
  return { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key' };
}

async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function openPort(): Promise<{ port: number; close: () => Promise<void> }> {
  const server = net.createServer((socket) => socket.destroy());
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return { port, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

describe('doctor --all', () => {
  it('selects datasources by env, namespace and kind', () => {
    // arrange
    const all = [
      profile('qa-a', 'qa', 'redis', 1, { namespace: 'one' }),
      profile('qa-b', 'qa', 'mysql', 2, { namespace: 'one' }),
      profile('qa-c', 'qa', 'redis', 3, { namespace: 'two' }),
      profile('prod-a', 'prod', 'redis', 4),
    ];

    // act
    const picked = selectDatasources(all, { env: 'qa', namespace: 'one', kind: 'redis' });

    // assert
    expect(picked.map((d) => d.name)).toEqual(['qa-a']);
  });

  it('maps socket error codes to a status', () => {
    // act / assert
    expect(tcpStatusOf('ECONNREFUSED')).toBe('refused');
    expect(tcpStatusOf('ETIMEDOUT')).toBe('timeout');
    expect(tcpStatusOf('ENOTFOUND')).toBe('unresolved');
    expect(tcpStatusOf('EPERM')).toBe('error');
  });

  it('reports a listening port as reachable and a closed one as refused', async () => {
    // arrange
    const open = await openPort();
    const closed = await closedPort();

    // act
    const up = await probeTcp('127.0.0.1', open.port);
    const down = await probeTcp('127.0.0.1', closed);
    await open.close();

    // assert
    expect(up.status).toBe('reachable');
    expect(down.status).toBe('refused');
  });

  it('checks every datasource of one env with --tcp-only and exits NOT_READY when one is down', async () => {
    // arrange
    const closed = await closedPort();
    const env = stateWith([
      profile('qa-cache', 'qa', 'redis', closed, { connectors: ['kubectl-portforward'] }),
      profile('qa-db', 'qa', 'mysql', closed),
      profile('prod-cache', 'prod', 'redis', closed),
    ]);

    // act
    const out = runCli(['doctor', '--all', '--env', 'qa', '--tcp-only'], env);

    // assert
    expect(out.status).toBe(7);
    const data = JSON.parse(out.stdout).data;
    expect(data.rows.map((r: { datasource: string }) => r.datasource)).toEqual(['qa-cache', 'qa-db']);
    expect(data.rows[0]).toEqual(expect.objectContaining({ status: 'refused', fix: 'taproot doctor --datasource qa-cache --connect' }));
    expect(data.rows[1].fix).toBeUndefined();
  });

  it('runs plugin doctor per datasource without --tcp-only', () => {
    // arrange
    stubRedisCli(`for a in "$@"; do [ "$a" = "6390" ] && { echo PONG; exit 0; }; done\necho 'Could not connect to Redis at 127.0.0.1:6391: Connection refused' >&2\nexit 1\n`);
    const env = stateWith([profile('qa-up', 'qa', 'redis', 6390), profile('qa-down', 'qa', 'redis', 6391)]);

    // act
    const out = runCli(['doctor', '--all', '--env', 'qa'], env);

    // assert
    expect(out.status).toBe(7);
    const rows = JSON.parse(out.stdout).data.rows;
    expect(rows[0]).toEqual({ datasource: 'qa-up', kind: 'redis', status: 'reachable' });
    expect(rows[1]).toEqual(expect.objectContaining({ datasource: 'qa-down', status: 'fail' }));
    expect(rows[1].detail).toContain('Connection refused');
  });

  it('counts a datasource it could not check as not ready', () => {
    // arrange
    const env = stateWith([profile('qa-remote', 'qa', 'mysql', 0, { connection: { target: 'remote-db' } })]);

    // act
    const out = runCli(['doctor', '--all', '--env', 'qa', '--tcp-only'], env);

    // assert
    expect(out.status).toBe(7);
    expect(JSON.parse(out.stdout).data.rows[0].status).toBe('skipped');
  });

  it('refuses --all without --env', () => {
    // arrange
    const env = stateWith([]);

    // act
    const out = runCli(['doctor', '--all'], env);

    // assert
    expect(out.status).not.toBe(0);
    expect(`${out.stdout}${out.stderr}`).toContain('needs --env');
  });

  it('refuses --all with --connect', () => {
    // arrange
    const env = stateWith([]);

    // act
    const out = runCli(['doctor', '--all', '--env', 'qa', '--connect'], env);

    // assert
    expect(out.status).not.toBe(0);
    expect(`${out.stdout}${out.stderr}`).toContain('never runs connect steps');
  });
});
