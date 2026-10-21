import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

function runCli(args: string[], env: Record<string, string> = {}) {
  const distCli = path.join(process.cwd(), 'dist', 'index.js');
  return spawnSync(process.execPath, [distCli, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

describe('learn empty states', () => {
  it('returns actionable empty state for schema refresh', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-learn-empty-'));
    const configDir = path.join(stateRoot, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'datasources.json'),
      JSON.stringify([
        {
          name: 'qa-orders',
          kind: 'mysql',
          env: 'qa',
          service: 'orders',
          tags: [],
          connection: { host: '127.0.0.1', port: 3306, database: 'orders' },
          credentialRef: 'qa:orders',
          connectors: [],
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          resolverHints: {},
          updatedAt: new Date().toISOString(),
          confidence: 0.9,
        },
      ]),
    );
    const out = runCli(['learn', 'tables', '--datasource', 'qa-orders'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
    });
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({
      datasource: 'qa-orders',
      rows: [],
      emptyReason: 'schema_refresh_required',
      suggestedNextCommand: 'taproot learn refresh-schema --datasource qa-orders',
    });
  });

  it('returns actionable empty state for schema snapshot', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-learn-schema-empty-'));
    const configDir = path.join(stateRoot, 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, 'datasources.json'),
      JSON.stringify([
        {
          name: 'qa-orders',
          kind: 'mysql',
          env: 'qa',
          service: 'orders',
          tags: [],
          connection: { host: '127.0.0.1', port: 3306, database: 'orders' },
          credentialRef: 'qa:orders',
          connectors: [],
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          resolverHints: {},
          updatedAt: new Date().toISOString(),
          confidence: 0.9,
        },
      ]),
    );
    const out = runCli(['learn', 'schema', '--datasource', 'qa-orders'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
    });
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({
      datasource: 'qa-orders',
      tables: [],
      joins: [],
      emptyReason: 'schema_refresh_required',
      suggestedNextCommand: 'taproot learn refresh-schema --datasource qa-orders',
    });
  });

  it('does not fall back to global learned schema for unresolved targeted schema requests', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-learn-schema-unresolved-'));
    const learningDir = path.join(stateRoot, 'learning');
    fs.mkdirSync(learningDir, { recursive: true });
    fs.writeFileSync(
      path.join(learningDir, 'schema-observations.json'),
      JSON.stringify([
        {
          key: 'other|db|orders',
          datasource: 'qa-other-service',
          env: 'qa',
          service: 'other-service',
          kind: 'mysql',
          database: 'other_db',
          target: '',
          table: 'orders',
          aliases: [],
          columns: [
            {
              column: 'id',
              selectedCount: 1,
              filterCount: 0,
              groupCount: 0,
              orderCount: 0,
              lastSeenAt: '2026-04-08T08:00:00.000Z',
            },
          ],
          firstSeenAt: '2026-04-08T08:00:00.000Z',
          lastSeenAt: '2026-04-08T08:00:00.000Z',
          sightings: 1,
          confidence: 0.8,
          sources: ['observed-query'],
        },
      ]),
    );
    fs.writeFileSync(path.join(learningDir, 'schema-joins.json'), '[]');

    const out = runCli(['learn', 'schema', '--env', 'develop', '--service', 'order-processor'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
    });
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({
      datasource: null,
      tables: [],
      joins: [],
      emptyReason: 'datasource_unresolved',
      suggestedNextCommand: 'taproot init datasource --env develop --service order-processor',
    });
  });

  it('does not fall back to global learned tables for unresolved targeted table requests', () => {
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-learn-tables-unresolved-'));
    const learningDir = path.join(stateRoot, 'learning');
    fs.mkdirSync(learningDir, { recursive: true });
    fs.writeFileSync(
      path.join(learningDir, 'schema-observations.json'),
      JSON.stringify([
        {
          key: 'other|db|orders',
          datasource: 'qa-other-service',
          env: 'qa',
          service: 'other-service',
          kind: 'mysql',
          database: 'other_db',
          target: '',
          table: 'orders',
          aliases: [],
          columns: [],
          firstSeenAt: '2026-04-08T08:00:00.000Z',
          lastSeenAt: '2026-04-08T08:00:00.000Z',
          sightings: 1,
          confidence: 0.8,
          sources: ['observed-query'],
        },
      ]),
    );

    const out = runCli(['learn', 'tables', '--env', 'develop', '--service', 'order-processor'], {
      TAPROOT_STATE_ROOT: stateRoot,
      TAPROOT_MASTER_KEY: 'test-key',
    });
    expect(out.status).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({
      datasource: null,
      rows: [],
      emptyReason: 'datasource_unresolved',
      suggestedNextCommand: 'taproot init datasource --env develop --service order-processor',
    });
  });
});
