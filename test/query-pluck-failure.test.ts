import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';

function setupStateRoot(): string {
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
        resolverHints: { dbUser: 'reader' },
        updatedAt: new Date().toISOString(),
        confidence: 0.9,
      },
    ]),
  );
  fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');
  return stateRoot;
}

describe('query failure with --pluck', () => {
  it('exits non-zero and prints the full error envelope instead of the plucked value', () => {
    const stateRoot = setupStateRoot();
    const out = runCli(
      ['query', '--datasource', 'prod-orders', '--sql', 'SELECT 1 AS ok', '--pluck', 'data.rows'],
      { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key', TAPROOT_FORCE_DIRECT: '1', PATH: '' },
    );
    // act / assert
    expect(out.status).not.toBe(0);
    expect(out.stderr).toBe('');
    const parsed = JSON.parse(out.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBeTruthy();
  });

  it('keeps the full error envelope on stdout when --pluck is absent', () => {
    const stateRoot = setupStateRoot();
    const out = runCli(
      ['query', '--datasource', 'prod-orders', '--sql', 'SELECT 1 AS ok'],
      { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key', TAPROOT_FORCE_DIRECT: '1', PATH: '' },
    );
    // act / assert
    expect(out.status).not.toBe(0);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.ok).toBe(false);
  });

  it('prints the single-line error envelope and exits non-zero under --lines', () => {
    const stateRoot = setupStateRoot();
    const out = runCli(
      ['query', '--datasource', 'prod-orders', '--sql', 'SELECT 1 AS ok', '--lines'],
      { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key', TAPROOT_FORCE_DIRECT: '1', PATH: '' },
    );
    // act / assert
    expect(out.status).not.toBe(0);
    const lines = out.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBeTruthy();
  });
});

describe('datasource list with --lines', () => {
  it('prints a header line and one line per datasource', () => {
    const stateRoot = setupStateRoot();
    const out = runCli(['datasource', 'list', '--lines'], { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key' });
    // act / assert
    expect(out.status).toBe(0);
    const lines = out.stdout.trim().split('\n').map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ ok: true, columns: expect.arrayContaining(['name']) });
    expect(lines.slice(1).map((row) => row[0])).toEqual(['prod-orders']);
  });
});
