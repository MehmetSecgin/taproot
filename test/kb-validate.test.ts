import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { AccessMethod } from '../src/types/core.js';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';

function kbWith(services: unknown): Record<string, string> {
  const { stateRoot } = tempStateRoot();
  const kbDir = path.join(stateRoot, 'kb');
  fs.mkdirSync(kbDir, { recursive: true });
  fs.writeFileSync(path.join(kbDir, 'services.json'), JSON.stringify(services));
  return {
    TAPROOT_STATE_ROOT: stateRoot,
    TAPROOT_MASTER_KEY: 'test-key',
    TAPROOT_KB_DIR: kbDir,
  };
}

function connection(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    env: 'qa',
    namespace: 'develop',
    engine: 'mysql',
    database: 'orders',
    db_user: 'orders_reader',
    access_method: 'native',
    status: 'active',
    verified_at_utc: '2026-03-01T00:00:00Z',
    ...overrides,
  };
}

describe('kb validate', () => {
  it('passes a well-formed services.json', () => {
    // arrange
    const env = kbWith([{ service: 'orders', connections: [connection()] }]);

    // act
    const out = runCli(['kb', 'validate'], env);

    // assert
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout).data).toMatchObject({ valid: true, findings: [] });
  });

  it('reports an access_method outside the known set with its path', () => {
    // arrange
    const env = kbWith([{ service: 'orders', connections: [connection({ access_method: 'ssh' })] }]);

    // act
    const out = runCli(['kb', 'validate'], env);

    // assert
    expect(out.status).not.toBe(0);
    expect(out.stdout + out.stderr).toMatch(/orders.*connections\[0\]\.access_method/);
  });

  it('reports a service row without a service name', () => {
    // arrange
    const env = kbWith([{ connections: [connection()] }]);

    // act
    const out = runCli(['kb', 'validate'], env);

    // assert
    expect(out.status).not.toBe(0);
    expect(out.stdout + out.stderr).toMatch(/services\[0\]\.service/);
  });

  it('reports a verified_at_utc that is not an ISO timestamp', () => {
    // arrange
    const env = kbWith([{ service: 'orders', connections: [connection({ verified_at_utc: 'last tuesday' })] }]);

    // act
    const out = runCli(['kb', 'validate'], env);

    // assert
    expect(out.status).not.toBe(0);
    expect(out.stdout + out.stderr).toMatch(/verified_at_utc/);
  });

  it('reports a port that is not an integer', () => {
    // arrange
    const env = kbWith([{ service: 'orders', connections: [connection({ port: '3306x' })] }]);

    // act
    const out = runCli(['kb', 'validate'], env);

    // assert
    expect(out.status).not.toBe(0);
    expect(out.stdout + out.stderr).toMatch(/port/);
  });

  it('accepts unknown connection keys so a newer KB still validates', () => {
    // arrange
    const env = kbWith([{ service: 'orders', connections: [connection({ owner_team: 'payments' })] }]);

    // act
    const out = runCli(['kb', 'validate'], env);

    // assert
    expect(out.status).toBe(0);
  });

  it('keeps the JSON Schema access_method enum in step with the code', () => {
    // arrange
    const schema = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'docs', 'services.schema.json'), 'utf8'));

    // act
    const allowed = schema.items.properties.connections.items.properties.access_method.enum;

    // assert
    expect(allowed).toEqual(Object.values(AccessMethod));
  });
});
