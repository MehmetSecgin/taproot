import path from 'node:path';
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { outputEnvelope, outputError } from './helpers/cli-contract-envelopes.js';
import { parseJson } from './helpers/parse-json.js';
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
      },
    ]),
  );
  fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');
  return stateRoot;
}

const headerSchema = z.object({ ok: z.literal(true), columns: z.array(z.string()) });
const rowSchema = z.array(z.unknown());

describe('query failure with --pluck', () => {
  it('exits non-zero and prints the full error envelope instead of the plucked value', () => {
    // arrange
    const stateRoot = setupStateRoot();

    // act
    const out = runCli(
      ['query', '--datasource', 'prod-orders', '--sql', 'SELECT 1 AS ok', '--pluck', 'data.rows'],
      { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key', TAPROOT_FORCE_DIRECT: '1', PATH: '' },
    );

    // assert
    expect(out.status).not.toBe(0);
    expect(out.stderr).toBe('');
    expect(outputEnvelope(out.stdout)).toMatchObject({ ok: false });
    expect(outputError(out.stdout).code).not.toBe('');
  });

  it('keeps the full error envelope on stdout when --pluck is absent', () => {
    // arrange
    const stateRoot = setupStateRoot();

    // act
    const out = runCli(
      ['query', '--datasource', 'prod-orders', '--sql', 'SELECT 1 AS ok'],
      { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key', TAPROOT_FORCE_DIRECT: '1', PATH: '' },
    );

    // assert
    expect(out.status).not.toBe(0);
    expect(outputEnvelope(out.stdout)).toMatchObject({ ok: false });
  });

  it('prints the single-line error envelope and exits non-zero under --lines', () => {
    // arrange
    const stateRoot = setupStateRoot();

    // act
    const out = runCli(
      ['query', '--datasource', 'prod-orders', '--sql', 'SELECT 1 AS ok', '--lines'],
      { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key', TAPROOT_FORCE_DIRECT: '1', PATH: '' },
    );

    // assert
    expect(out.status).not.toBe(0);
    const lines = out.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(outputEnvelope(out.stdout)).toMatchObject({ ok: false });
    expect(outputError(out.stdout).code).not.toBe('');
  });
});

describe('datasource list with --lines', () => {
  it('prints a header line and one line per datasource', () => {
    // arrange
    const stateRoot = setupStateRoot();

    // act
    const out = runCli(['datasource', 'list', '--lines'], { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key' });

    // assert
    expect(out.status).toBe(0);
    const parsedLines: unknown[] = out.stdout.trim().split('\n').map((line) => parseJson(line));
    const [header, ...rows] = parsedLines;
    expect(headerSchema.parse(header).columns).toContain('name');
    expect(rows.map((row) => rowSchema.parse(row)[0])).toStrictEqual(['prod-orders']);
  });
});
