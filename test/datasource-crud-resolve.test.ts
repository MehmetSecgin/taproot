import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { outputData } from './helpers/cli-contract-envelopes.js';
import { parseJson } from './helpers/parse-json.js';
import { addProfile, setupEmptyState } from './helpers/datasource-crud-state.js';
import { runCli } from './helpers/cli.js';

const resolveResultSchema = z.object({ source: z.string(), profile: z.record(z.string(), z.unknown()) });
const storedProfilesSchema = z.array(z.looseObject({ name: z.string() }));

describe('datasource resolve', () => {
  it('resolves the profile that matches the given env and service', () => {
    const { env } = setupEmptyState();
    addProfile(env);
    const out = runCli(['datasource', 'resolve', '--env', 'qa', '--service', 'svc'], env);
    expect(out.status).toBe(0);
    const resolved = outputData(out.stdout, resolveResultSchema);
    expect(resolved.source).toBe('datasource-store');
    expect(resolved.profile.name).toBe('qa-svc');
  });

  it('datasource resolve by env+namespace+service prefers exact namespace match', () => {
    const { env } = setupEmptyState();
    addProfile(env, ['--namespace', 'develop']);
    runCli(
      [
        'datasource',
        'add',
        '--name',
        'qa-svc-test',
        '--kind',
        'mysql',
        '--credential-ref',
        'qa:svc',
        '--env',
        'qa',
        '--namespace',
        'test',
        '--service',
        'svc',
        '--host',
        '127.0.0.1',
        '--port',
        '3306',
        '--database',
        'svcdb',
      ],
      env,
    );
    const out = runCli(['datasource', 'resolve', '--env', 'qa', '--namespace', 'develop', '--service', 'svc'], env);
    expect(out.status).toBe(0);
    expect(outputData(out.stdout, resolveResultSchema).profile).toMatchObject({ name: 'qa-svc', namespace: 'develop' });
  });

  it('datasource resolve from KB saves canonical bootstrap shape', () => {
    const { env, stateRoot, kbDir } = setupEmptyState();
    fs.writeFileSync(
      path.join(kbDir, 'services.json'),
      JSON.stringify([
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
      ]),
    );

    const out = runCli(['datasource', 'resolve', '--env', 'prod', '--service', 'orders'], env);
    expect(out.status).toBe(0);
    const resolved = outputData(out.stdout, resolveResultSchema);
    expect(resolved.source).toBe('kb');
    expect(resolved.profile).toMatchObject({
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

    const savedText = fs.readFileSync(path.join(stateRoot, 'config', 'datasources.json'), 'utf8');
    const saved = storedProfilesSchema.parse(parseJson(savedText));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({
      name: 'prod-orders',
      kind: 'teleport-mysql',
      tags: ['auto-bootstrap', 'kb-derived'],
    });
  });
});
