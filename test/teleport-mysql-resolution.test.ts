import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SpawnSyncReturns } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';

function seedTeleportState(resolverHints: Record<string, string>): string {
  const { stateRoot, configDir } = tempStateRoot();
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

function runQuery(stateRoot: string, pathEnv: string): SpawnSyncReturns<string> {
  return runCli(
    ['query', '--datasource', 'prod-orders', '--sql', 'SELECT 1 AS ok'],
    { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key', TAPROOT_FORCE_DIRECT: '1', PATH: pathEnv },
  );
}


describe('teleport mysql db user resolution', () => {
  it('fails cleanly without tsh db exec fallback when tsh is missing', () => {
    // arrange
    const stateRoot = seedTeleportState({});
    const baseEnv = { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key', TAPROOT_FORCE_DIRECT: '1' };
    const seed = runCli(['creds', 'set', '--ref', 'prod:orders', '--db-user', 'reader'], baseEnv);

    // act
    const out = runCli(['query', '--datasource', 'prod-orders', '--sql', 'SELECT 1 AS ok'], { ...baseEnv, PATH: '' });

    // assert
    expect(seed.status).toBe(0);
    expect(out.status).toBe(7);
    expect(out.stdout).toContain('MISSING_TOOL: tsh is not installed');
    expect(out.stdout).not.toContain('tsh db exec');
    expect(out.stdout).not.toContain('fallback');
  });

  it('resolves dbUser from datasource resolverHints when credentials lack one', () => {
    // arrange
    const stateRoot = seedTeleportState({ dbUser: 'reader' });

    // act
    const out = runQuery(stateRoot, '');

    // assert
    expect(out.stdout).toContain('MISSING_TOOL: tsh is not installed');
    expect(out.stdout).not.toMatch(/missing .*dbUser/u);
  });

  it('names a remedy when dbUser is missing everywhere', () => {
    // arrange
    const stateRoot = seedTeleportState({});

    // act
    const out = runQuery(stateRoot, stubTsh([]));

    // assert
    expect(out.status).not.toBe(0);
    expect(out.stdout).toMatch(/creds set --ref prod:orders --db-user|datasource resolve/u);
  });

  it('takes the db user from tsh db ls when exactly one is allowed', () => {
    // arrange
    const stateRoot = seedTeleportState({});
    const pathEnv = stubTsh([{ metadata: { name: 'orders-tidb' }, spec: { protocol: 'mysql' }, users: { allowed: ['reader', '*'] } }]);

    // act
    const out = runQuery(stateRoot, pathEnv);

    // assert
    expect(out.stdout).toContain('--db-user reader');
    expect(out.stdout).not.toMatch(/missing .*dbUser/u);
  });

  it('lists the allowed users when tsh db ls offers several', () => {
    // arrange
    const stateRoot = seedTeleportState({});
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
    const stateRoot = seedTeleportState({ dbUser: 'writer' });
    const pathEnv = stubTsh([{ metadata: { name: 'orders-tidb' }, spec: { protocol: 'mysql' }, users: { allowed: ['reader'] } }]);

    // act
    const out = runQuery(stateRoot, pathEnv);

    // assert
    expect(out.stdout).toContain('--db-user writer');
  });
});
