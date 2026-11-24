import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { parseJson } from './helpers/parse-json.js';
import { runCli } from './helpers/cli.js';
import { setupState } from './helpers/query-resolution-state.js';

const savedProfilesSchema = z.array(z.looseObject({ name: z.string() }));

function savedProfiles(stateRoot: string): z.infer<typeof savedProfilesSchema> {
  const text = fs.readFileSync(path.join(stateRoot, 'config', 'datasources.json'), 'utf8');
  return savedProfilesSchema.parse(parseJson(text));
}

describe('query resolution with --allow-discovery', () => {
  it('allow-discovery reuses canonical bootstrap shape for KB-backed discovery targets', () => {
    const { env, stateRoot } = setupState({
      datasources: [],
      kbServices: [
        {
          service: 'orders',
          connections: [
            {
              env: 'prod',
              engine: 'mysql',
              database: 'orders',
              db_user: 'reader',
              access_method: 'tsh',
              target: 'orders-tidb',
              status: 'active',
              verified_at_utc: '2026-03-01T00:00:00Z',
            },
          ],
        },
      ],
    });
    const out = runCli(['query', '--env', 'prod', '--service', 'orders', '--allow-discovery'], {
      ...env,
      PATH: '',
    });
    expect(out.status).not.toBe(0);

    const datasources = savedProfiles(stateRoot);
    expect(datasources).toHaveLength(1);
    expect(datasources[0]).toMatchObject({
      name: 'prod-orders',
      kind: 'teleport-mysql',
      env: 'prod',
      service: 'orders',
      tags: ['auto-bootstrap', 'kb-derived'],
      connection: {
        database: 'orders',
        target: 'orders-tidb',
      },
      credentialRef: 'prod',
      connectors: ['teleport'],
      resolverHints: {
        teleportCredentialRef: 'tsh:prod',
      },
    });
  });

  it('allow-discovery without a KB row writes a port-forward profile for a Kubernetes target', () => {
    const { env, stateRoot } = setupState({
      datasources: [],
      runtimeConfig: { environmentPolicies: { qa: { preferredAccessMethods: ['tsh', 'kubectl-portforward'] } } },
    });
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-fake-kubectl-'));
    fs.writeFileSync(path.join(binDir, 'kubectl'), '#!/bin/sh\necho service/orders-mysql\n', { mode: 0o755 });
    runCli(['query', '--env', 'qa', '--service', 'orders', '--sql', 'SELECT 1', '--allow-discovery'], {
      ...env,
      PATH: binDir,
    });

    const datasources = savedProfiles(stateRoot);
    expect(datasources).toHaveLength(1);
    expect(datasources[0]).toMatchObject({ kind: 'mysql', connectors: ['kubectl-portforward'] });
  });

  it('allow-discovery writes a port-forward profile for a KB row without an access_method', () => {
    // arrange
    const { env, stateRoot } = setupState({
      datasources: [],
      kbServices: [{ service: 'orders', connections: [{ env: 'qa', engine: 'mysql', database: 'orders', status: 'active' }] }],
      runtimeConfig: { environmentPolicies: { qa: { preferredAccessMethods: ['kubectl-portforward'] } } },
    });
    const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-fake-kubectl-'));
    fs.writeFileSync(path.join(binDir, 'kubectl'), '#!/bin/sh\necho service/orders-mysql\n', { mode: 0o755 });

    // act
    runCli(['query', '--env', 'qa', '--service', 'orders', '--sql', 'SELECT 1', '--allow-discovery'], { ...env, PATH: binDir });

    // assert
    const datasources = savedProfiles(stateRoot);
    expect(datasources[0]).toMatchObject({ connection: { database: 'orders' }, connectors: ['kubectl-portforward'] });
  });
});
