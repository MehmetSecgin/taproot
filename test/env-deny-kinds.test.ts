import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeQuery, silentQueryReport } from '../src/core/execute-query.js';
import type { RuntimeConfig } from '../src/types/core.js';
import { fakePlugin } from './helpers/fake-plugin.js';
import { contextWith, queryRequest, restoreQueryEnv, setupQueryState } from './helpers/query-state.js';

beforeEach(async () => {
  await setupQueryState();
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreQueryEnv();
});

function withEnvironmentPolicies(ctx: ReturnType<typeof contextWith>, config: RuntimeConfig): void {
  vi.spyOn(ctx.runtimeConfigStore, 'get').mockReturnValue(config);
}

describe('environmentPolicies.denyKinds', () => {
  it('refuses a datasource whose kind is denied in the request environment, before the plugin runs', async () => {
    // arrange
    let pluginCalled = false;
    const plugin = fakePlugin();
    const inner = plugin.execute!;
    plugin.execute = async (request, creds) => {
      pluginCalled = true;
      return inner(request, creds);
    };
    const ctx = contextWith(plugin);
    withEnvironmentPolicies(ctx, { environmentPolicies: { qa: { denyKinds: ['fake'] } } });

    // act
    const outcome = await executeQuery(queryRequest(), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined });

    // assert
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/denyKinds/);
    expect(outcome.message).toMatch(/'fake'/);
    expect(pluginCalled).toBe(false);
  });

  it('runs a datasource whose kind is not in denyKinds', async () => {
    // arrange
    const ctx = contextWith(fakePlugin());
    withEnvironmentPolicies(ctx, { environmentPolicies: { qa: { denyKinds: ['kafka'] } } });

    // act
    const outcome = await executeQuery(queryRequest(), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined });

    // assert
    expect(outcome.ok).toBe(true);
  });

  it('applies no deny when environmentPolicies sets no denyKinds', async () => {
    // arrange
    const ctx = contextWith(fakePlugin());
    withEnvironmentPolicies(ctx, { environmentPolicies: { qa: { deterministicRequired: false } } });

    // act
    const outcome = await executeQuery(queryRequest(), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined });

    // assert
    expect(outcome.ok).toBe(true);
  });
});
