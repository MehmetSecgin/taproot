import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { queryRoute } from '../src/commands/query-route.js';
import { queryRequest } from './helpers/query-state.js';

const savedForceDirect = process.env.TAPROOT_FORCE_DIRECT;
const savedStateRoot = process.env.TAPROOT_STATE_ROOT;

beforeEach(() => {
  delete process.env.TAPROOT_FORCE_DIRECT;
});

afterEach(() => {
  if (savedForceDirect === undefined) delete process.env.TAPROOT_FORCE_DIRECT;
  else process.env.TAPROOT_FORCE_DIRECT = savedForceDirect;
  if (savedStateRoot === undefined) delete process.env.TAPROOT_STATE_ROOT;
  else process.env.TAPROOT_STATE_ROOT = savedStateRoot;
});

describe('queryRoute', () => {
  it('routes an ordinary query to the daemon', () => {
    expect(queryRoute(queryRequest())).toBe('daemon');
  });

  it('routes to direct when TAPROOT_FORCE_DIRECT is set', () => {
    process.env.TAPROOT_FORCE_DIRECT = '1';
    expect(queryRoute(queryRequest())).toBe('direct');
  });

  it('routes to direct when discovery is enabled, because the daemon refuses discovery', () => {
    expect(queryRoute(queryRequest({ allowDiscovery: true }))).toBe('direct');
  });

  it('routes to direct when the daemon socket path is longer than a unix socket allows', () => {
    process.env.TAPROOT_STATE_ROOT = `/tmp/${'nested-state-root/'.repeat(6)}`;
    expect(queryRoute(queryRequest())).toBe('direct');
  });

  it('routes an explain query to the daemon', () => {
    expect(queryRoute(queryRequest({ explain: true }))).toBe('daemon');
  });

  it('routes a json-extract query to the daemon', () => {
    expect(queryRoute(queryRequest({ jsonExtract: ['payload:order.id'] }))).toBe('daemon');
  });
});
