import { describe, expect, it } from 'vitest';
import { outputError } from './helpers/cli-contract-envelopes.js';
import { runCli } from './helpers/cli.js';
import { setupState } from './helpers/query-resolution-state.js';

describe('query resolution', () => {
  it('uses the saved profile named by --datasource', () => {
    const { env } = setupState();
    const out = runCli(['query', '--datasource', 'qa-orders', '--sql', 'SELECT 1'], env);
    expect(out.status).toBe(3);
    expect(out.stdout).not.toContain('DETERMINISTIC_REQUIRED');
  });

  it('names every matching profile instead of picking one when env and service match several', () => {
    // arrange
    const orders = {
      kind: 'mysql',
      env: 'qa',
      service: 'orders',
      tags: [],
      connection: { host: '127.0.0.1', port: 1, database: 'orders' },
      credentialRef: 'qa:orders',
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      updatedAt: new Date().toISOString(),
    };
    const { env } = setupState({
      datasources: [
        { ...orders, name: 'qa-orders-develop', namespace: 'develop' },
        { ...orders, name: 'qa-orders-test', namespace: 'test' },
      ],
    });
    // act
    const out = runCli(['query', '--env', 'qa', '--service', 'orders', '--sql', 'SELECT 1'], env);
    // assert
    expect(out.status).toBe(2);
    const { code, message } = outputError(out.stdout);
    expect(code).toBe('AMBIGUOUS_DATASOURCE');
    expect(message).toContain('qa-orders-develop, qa-orders-test. Narrow with --namespace, or use --datasource <name> on query and doctor.');
  });

  it('takes env and service from the saved profile, not from a profile name that looks like env-service, when checking KB conflicts', () => {
    const { env } = setupState({
      datasources: [
        {
          name: 'nudge-test',
          kind: 'mysql',
          env: 'prod',
          service: 'orders',
          tags: [],
          connection: { host: '127.0.0.1', port: 3306, database: 'orders', target: 'wrong-target' },
          credentialRef: 'prod:orders',
          connectors: [],
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          resolverHints: {},
          updatedAt: new Date().toISOString(),
        },
      ],
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
    const out = runCli(['query', '--datasource', 'nudge-test', '--sql', 'SELECT 1'], env);
    expect(out.stdout).toContain('MISCONFIGURED_DATASOURCE');
  });

  it('resolves --env + --service from store', () => {
    const { env } = setupState();
    const out = runCli(['query', '--env', 'qa', '--service', 'orders', '--sql', 'SELECT 1'], env);
    expect(out.status).toBe(3);
    expect(out.stdout).not.toContain('DETERMINISTIC_REQUIRED');
  });

  it('reports DETERMINISTIC_REQUIRED when the env policy enforces it', () => {
    const { env } = setupState({
      datasources: [],
      runtimeConfig: {
        environmentPolicies: {
          prod: {
            deterministicRequired: true,
            allowDiscoveryByDefault: false,
          },
        },
      },
    });
    const out = runCli(['query', '--env', 'prod', '--service', 'unknown', '--sql', 'SELECT 1'], env);
    expect(out.status).toBe(2);
    expect(out.stdout).toContain('DETERMINISTIC_REQUIRED');
    expect(out.stdout).toContain(`KB directory ${env.TAPROOT_KB_DIR} has no services in services.json`);
  });

  it('lets a query run unresolved in prod when --allow-discovery is set', () => {
    const { env } = setupState({
      datasources: [],
      runtimeConfig: {
        environmentPolicies: {
          prod: {
            deterministicRequired: true,
            allowDiscoveryByDefault: false,
          },
        },
      },
    });
    const out = runCli(['query', '--env', 'prod', '--service', 'unknown', '--sql', 'SELECT 1', '--allow-discovery'], env);
    expect(out.status).toBe(2);
    expect(out.stdout).toContain('UNKNOWN_DATASOURCE');
    expect(out.stdout).not.toContain('DETERMINISTIC_REQUIRED');
  });

  it('allow-discovery names an unknown preferredAccessMethods entry and the known ones', () => {
    // arrange
    const { env } = setupState({
      datasources: [],
      runtimeConfig: { environmentPolicies: { qa: { preferredAccessMethods: ['qa-portforward'] } } },
    });

    // act
    const out = runCli(['query', '--env', 'qa', '--service', 'orders', '--sql', 'SELECT 1', '--allow-discovery'], env);

    // assert
    expect(outputError(out.stdout)).toMatchObject({
      code: 'BAD_INPUT',
      message: "BAD_INPUT: Unknown access method 'qa-portforward' in environmentPolicies.qa.preferredAccessMethods. Known: kubectl-portforward, native, tsh.",
    });
  });

  it('rejects the removed --reason and --allow-schema-introspection flags', () => {
    // arrange
    const { env } = setupState();

    // act
    const outputs = [['--reason', 'why'], ['--allow-schema-introspection']].map((flag) =>
      runCli(['query', '--datasource', 'qa-orders', '--sql', 'SELECT 1', ...flag], env));

    // assert
    expect(outputs.map((out) => out.status === 0)).toStrictEqual([false, false]);
    expect(outputs.map((out) => outputError(out.stdout).code)).toStrictEqual(['CLI_ERROR', 'CLI_ERROR']);
  });

  it('malformed --param fails as bad input', () => {
    const { env } = setupState();
    const out = runCli(['query', '--datasource', 'qa-orders', '--sql', 'SELECT 1', '--param', 'brokenpair'], env);
    expect(out.status).toBe(2);
    expect(out.stdout).toContain("Invalid --param 'brokenpair'");
  });

  it('--explain without a query fails as bad input', () => {
    const { env } = setupState();
    const out = runCli(['query', '--datasource', 'qa-orders', '--explain'], env);
    expect(out.status).toBe(2);
    expect(outputError(out.stdout).code).toBe('BAD_INPUT');
    expect(outputError(out.stdout).message).toContain('--explain requires --sql');
  });

  it('service alias resolves transparently in query', () => {
    const { env } = setupState({
      runtimeConfig: {
        serviceAliases: {
          legacy: 'orders',
        },
      },
    });
    const out = runCli(['query', '--env', 'qa', '--service', 'legacy', '--sql', 'SELECT 1'], env);
    expect(out.status).toBe(3);
    expect(out.stdout).not.toContain('DETERMINISTIC_REQUIRED');
  });

  it('fails with MISCONFIGURED_DATASOURCE when store conflicts with stronger KB routing', () => {
    const { env } = setupState({
      datasources: [
        {
          name: 'prod-orders',
          kind: 'mysql',
          env: 'prod',
          service: 'orders',
          tags: [],
          connection: { host: '127.0.0.1', port: 3306, database: 'orders' },
          credentialRef: 'prod:orders',
          connectors: [],
          policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
          resolverHints: {},
          updatedAt: new Date().toISOString(),
        },
      ],
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
    const out = runCli(['query', '--env', 'prod', '--service', 'orders', '--sql', 'SELECT 1'], env);
    expect(out.status).toBe(2);
    expect(out.stdout).toContain('MISCONFIGURED_DATASOURCE');
  });
});
