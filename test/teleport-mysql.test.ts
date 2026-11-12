import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import mysql from 'mysql2';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeAllMysqlPools } from '../src/plugins-builtins/_shared/db-conn.js';
import { closeTeleportMysqlSessionProxies, teleportMysqlPlugin } from '../src/plugins-builtins/teleport-mysql/index.js';
import type { DatasourceProfile, QueryRequest } from '../src/types/core.js';
import { column, startFakeMysqlServer, type FakeMysqlServer } from './helpers/fake-mysql-server.js';

function runCli(args: string[], env: Record<string, string> = {}) {
  const distCli = path.join(process.cwd(), 'dist', 'index.js');
  return spawnSync(process.execPath, [distCli, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function seedTeleportState(prefix: string, resolverHints: Record<string, string>): string {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configDir = path.join(stateRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'datasources.json'),
    JSON.stringify([
      {
        name: 'prod-orders',
        kind: 'teleport-mysql',
        env: 'prod',
        service: 'orders',
        tags: [],
        connection: { target: 'orders-tidb', database: 'orders' },
        credentialRef: 'prod:orders',
        connectors: [],
        policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
        resolverHints,
        updatedAt: new Date().toISOString(),
        confidence: 0.9,
      },
    ]),
  );
  fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');
  return stateRoot;
}

function stubTsh(databases: unknown[]): string {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-tsh-stub-'));
  const listing = path.join(binDir, 'db-ls.json');
  fs.writeFileSync(listing, JSON.stringify(databases));
  const script = path.join(binDir, 'tsh');
  fs.writeFileSync(script, `#!/bin/sh\nif [ "$1" = "db" ]; then cat '${listing}'; exit 0; fi\necho "proxy args: $*" >&2\nexit 1\n`);
  fs.chmodSync(script, 0o755);
  return `${binDir}:/usr/bin:/bin`;
}

function runQuery(stateRoot: string, pathEnv: string) {
  return runCli(
    ['query', '--datasource', 'prod-orders', '--sql', 'SELECT 1 AS ok'],
    { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key', TAPROOT_FORCE_DIRECT: '1', PATH: pathEnv },
  );
}

function stubForwardingTsh(upstreamPort: number): { pathEnv: string; proxyPids: () => number[] } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-tsh-forward-'));
  const pids = path.join(binDir, 'pids');
  const forwarder = path.join(binDir, 'forward.mjs');
  fs.writeFileSync(
    forwarder,
    [
      "import net from 'node:net';",
      "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
      'net.createServer((client) => {',
      `  const upstream = net.connect(${upstreamPort}, '127.0.0.1');`,
      "  client.on('error', () => upstream.destroy());",
      "  upstream.on('error', () => client.destroy());",
      '  client.pipe(upstream).pipe(client);',
      "}).listen(port, '127.0.0.1');",
    ].join('\n'),
  );
  const script = path.join(binDir, 'tsh');
  fs.writeFileSync(script, `#!/bin/sh\necho $$ >> '${pids}'\nexec '${process.execPath}' '${forwarder}' "$@"\n`);
  fs.chmodSync(script, 0o755);
  return {
    pathEnv: `${binDir}:${process.env.PATH}`,
    proxyPids: () => (fs.existsSync(pids) ? fs.readFileSync(pids, 'utf8').trim().split('\n').map(Number) : []),
  };
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilReaped(pid: number): Promise<void> {
  while (isRunning(pid)) await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('teleport mysql proxy reuse', () => {
  const sessionId = 'proxy-exit-session';
  let server: FakeMysqlServer | undefined;

  afterEach(async () => {
    await closeTeleportMysqlSessionProxies(sessionId);
    await closeAllMysqlPools();
    server?.close();
    vi.unstubAllEnvs();
  });

  it('starts a fresh proxy when the previous one exited on its own', async () => {
    // arrange
    server = await startFakeMysqlServer(() => ({ columns: [column('profiles', 'ok', mysql.Types.LONG)], row: ['1'] }), () => undefined);
    const tsh = stubForwardingTsh(server.port);
    vi.stubEnv('PATH', tsh.pathEnv);
    const request: QueryRequest = {
      datasource: { name: 'qa-profiles', kind: 'teleport-mysql', connection: { target: 'profiles-db', database: 'profiles' } } as DatasourceProfile,
      query: 'SELECT 1 AS ok',
      capability: 'executeRead',
      sessionTimeZone: '+00:00',
    };
    const creds = { dbUser: 'reader', password: '', __sessionId: sessionId };
    await teleportMysqlPlugin.execute!(request, creds);
    const [firstProxy] = tsh.proxyPids();
    process.kill(firstProxy, 'SIGTERM');
    await waitUntilReaped(firstProxy);

    // act
    const result = await teleportMysqlPlugin.execute!(request, creds);

    // assert
    expect(result.result.rows).toEqual([[1]]);
    expect(tsh.proxyPids()).toHaveLength(2);
  });
});

describe('teleport mysql execution', () => {
  it('fails cleanly without tsh db exec fallback when tsh is missing', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-teleport-'));
    const configDir = path.join(stateRoot, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'datasources.json'),
      JSON.stringify([
        {
          name: 'prod-orders',
          kind: 'teleport-mysql',
          env: 'prod',
          service: 'orders',
          tags: [],
          connection: { target: 'orders-tidb', database: 'orders' },
          credentialRef: 'prod:orders',
          connectors: [],
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          resolverHints: {},
          updatedAt: new Date().toISOString(),
          confidence: 0.9,
        },
      ]),
    );
    fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');
    const baseEnv = {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
      TAPROOT_FORCE_DIRECT: '1',
    };
    const seed = runCli(['creds', 'set', '--ref', 'prod:orders', '--db-user', 'reader'], baseEnv);
    expect(seed.status).toBe(0);
    const out = runCli(
      ['query', '--datasource', 'prod-orders', '--sql', 'SELECT 1 AS ok'],
      {
        ...baseEnv,
        PATH: '',
      },
    );
    expect(out.status).toBe(7);
    expect(out.stdout).toContain('MISSING_TOOL: tsh is not installed');
    expect(out.stdout).not.toContain('tsh db exec');
    expect(out.stdout).not.toContain('fallback');
  });

  it('resolves dbUser from datasource resolverHints when credentials lack one', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-teleport-hint-'));
    const configDir = path.join(stateRoot, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'datasources.json'),
      JSON.stringify([
        {
          name: 'prod-orders',
          kind: 'teleport-mysql',
          env: 'prod',
          service: 'orders',
          tags: [],
          connection: { target: 'orders-tidb', database: 'orders' },
          credentialRef: 'prod:orders',
          connectors: [],
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          resolverHints: { dbUser: 'reader' },
          updatedAt: new Date().toISOString(),
          confidence: 0.9,
        },
      ]),
    );
    fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');
    const out = runCli(
      ['query', '--datasource', 'prod-orders', '--sql', 'SELECT 1 AS ok'],
      { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key', TAPROOT_FORCE_DIRECT: '1', PATH: '' },
    );
    expect(out.stdout).toContain('MISSING_TOOL: tsh is not installed');
    expect(out.stdout).not.toMatch(/missing .*dbUser/);
  });

  it('names a remedy when dbUser is missing everywhere', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-teleport-nouser-'));
    const configDir = path.join(stateRoot, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'datasources.json'),
      JSON.stringify([
        {
          name: 'prod-orders',
          kind: 'teleport-mysql',
          env: 'prod',
          service: 'orders',
          tags: [],
          connection: { target: 'orders-tidb', database: 'orders' },
          credentialRef: 'prod:orders',
          connectors: [],
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          resolverHints: {},
          updatedAt: new Date().toISOString(),
          confidence: 0.9,
        },
      ]),
    );
    fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');
    const out = runQuery(stateRoot, stubTsh([]));
    expect(out.status).not.toBe(0);
    expect(out.stdout).toMatch(/creds set --ref prod:orders --db-user|datasource resolve/);
  });

  it('takes the db user from tsh db ls when exactly one is allowed', () => {
    // arrange
    const stateRoot = seedTeleportState('taproot-teleport-tshuser-', {});
    const pathEnv = stubTsh([{ metadata: { name: 'orders-tidb' }, spec: { protocol: 'mysql' }, users: { allowed: ['reader', '*'] } }]);

    // act
    const out = runQuery(stateRoot, pathEnv);

    // assert
    expect(out.stdout).toContain('--db-user reader');
    expect(out.stdout).not.toMatch(/missing .*dbUser/);
  });

  it('lists the allowed users when tsh db ls offers several', () => {
    // arrange
    const stateRoot = seedTeleportState('taproot-teleport-tshusers-', {});
    const pathEnv = stubTsh([{ metadata: { name: 'orders-tidb' }, spec: { protocol: 'mysql' }, users: { allowed: ['reader', 'writer'] } }]);

    // act
    const out = runQuery(stateRoot, pathEnv);

    // assert
    expect(out.status).not.toBe(0);
    expect(out.stdout).toContain('reader, writer');
    expect(out.stdout).toContain('creds set --ref prod:orders --db-user <user>');
    expect(out.stdout).toContain('--hint dbUser=<user>');
    expect(out.stdout).not.toContain('proxy args');
  });

  it('prefers an explicit dbUser hint over the tsh db ls user', () => {
    // arrange
    const stateRoot = seedTeleportState('taproot-teleport-explicit-', { dbUser: 'writer' });
    const pathEnv = stubTsh([{ metadata: { name: 'orders-tidb' }, spec: { protocol: 'mysql' }, users: { allowed: ['reader'] } }]);

    // act
    const out = runQuery(stateRoot, pathEnv);

    // assert
    expect(out.stdout).toContain('--db-user writer');
  });
});
