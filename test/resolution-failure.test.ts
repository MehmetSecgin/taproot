import { describe, expect, it } from 'vitest';
import { describeResolutionFailure } from '../src/core/resolve-datasource.js';
import type { DatasourceProfile } from '../src/types/core.js';

function profile(name: string, env: string, service: string, namespace?: string): DatasourceProfile {
  return {
    name,
    kind: 'mysql',
    env,
    namespace,
    service,
    tags: [],
    connection: { host: '127.0.0.1', port: 1, database: service },
    credentialRef: 'x',
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    updatedAt: '2026-01-01T00:00:00.000Z',
    confidence: 1,
  } as DatasourceProfile;
}

const profiles = [profile('qa-orders', 'qa', 'orders'), profile('stg-orders', 'stg', 'orders'), profile('prod-orders', 'prod', 'orders'), profile('qa-billing', 'qa', 'billing')];

describe('describeResolutionFailure', () => {
  it('names the sibling profiles and the missing env when a datasource name is asked', () => {
    // act
    const message = describeResolutionFailure(profiles, { rawDs: 'preprod-orders' });
    // assert
    expect(message).toBe(
      "Datasource resolution failed: no profile for datasource 'preprod-orders'. Profiles for service 'orders': prod-orders, qa-orders, stg-orders (envs: prod, qa, stg). No profile in env 'preprod'; add one with taproot datasource add.",
    );
  });

  it('uses env and service when no datasource name is asked', () => {
    const message = describeResolutionFailure(profiles, { env: 'preprod', service: 'orders' });
    expect(message).toContain("no profile for env=preprod service=orders.");
    expect(message).toContain("No profile in env 'preprod'");
  });

  it('skips the missing-env sentence when the env has a profile for that service', () => {
    const message = describeResolutionFailure(profiles, { rawDs: 'qa-orders-x', env: 'qa' });
    expect(message).toContain("Profiles for service 'orders'");
    expect(message).not.toContain('No profile in env');
  });

  it('reads the env from the name parts before the service and ignores trailing parts', () => {
    const message = describeResolutionFailure(profiles, { rawDs: 'qa-orders-x' });
    expect(message).toContain("Profiles for service 'orders'");
    expect(message).not.toContain('No profile in env');
  });

  it('does not match a service that is only part of a name segment', () => {
    const message = describeResolutionFailure(profiles, { rawDs: 'stg-ordersync' });
    expect(message).toContain('list profiles with taproot datasource list');
  });

  it('treats an env-namespace prefix as covered by a profile in that namespace', () => {
    const withNs = [...profiles, profile('qa-develop-db', 'qa', 'orders', 'develop')];
    const message = describeResolutionFailure(withNs, { rawDs: 'qa-develop-orders' });
    expect(message).toContain('(envs: prod, qa, qa/develop, stg)');
    expect(message).not.toContain('No profile in env');
  });

  it('names the namespace when the env has profiles but not in that namespace', () => {
    const withNs = [...profiles, profile('qa-develop-db', 'qa', 'orders', 'develop')];
    const message = describeResolutionFailure(withNs, { env: 'qa', namespace: 'test', service: 'orders' });
    expect(message).toContain("No profile in env 'qa' namespace 'test'");
  });

  it('suggests the closest profile names when nothing matches', () => {
    // act
    const message = describeResolutionFailure(profiles, { rawDs: 'qa-ordres' });
    // assert
    expect(message).toBe("Datasource resolution failed: no profile for datasource 'qa-ordres'. Did you mean qa-orders, stg-orders, prod-orders? Use --datasource or --env+--service; list profiles with taproot datasource list.");
  });

  it('points at the list command without suggestions when no name is asked', () => {
    const message = describeResolutionFailure(profiles, { env: 'qa', service: 'missing' });
    expect(message).toBe('Datasource resolution failed: no profile for env=qa service=missing. Use --datasource or --env+--service; list profiles with taproot datasource list.');
  });
});
