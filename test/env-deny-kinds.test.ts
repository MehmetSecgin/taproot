import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeQuery, silentQueryReport } from '../src/core/execute-query.js';
import type { TapRootPlugin } from '../src/types/core.js';
import { fakePlugin } from './helpers/fake-plugin.js';
import { contextWith, queryRequest, restoreQueryEnv, setupQueryState } from './helpers/query-state.js';

let stateRoot = '';

beforeEach(async () => {
  stateRoot = await setupQueryState({ env: 'prod' });
});

afterEach(() => {
  restoreQueryEnv();
});

function writePolicies(environmentPolicies: Record<string, { denyKinds: string[] }>): void {
  fs.writeFileSync(path.join(stateRoot, 'config', 'deterministic-config.json'), JSON.stringify({ environmentPolicies }));
}

function countingPlugin(): { plugin: TapRootPlugin; calls: () => number } {
  const plugin = fakePlugin();
  let calls = 0;
  for (const key of Object.keys(plugin) as Array<keyof TapRootPlugin>) {
    const value = plugin[key];
    if (typeof value === 'function') {
      (plugin as unknown as Record<string, unknown>)[key] = (...args: unknown[]) => {
        calls += 1;
        return (value as (...a: unknown[]) => unknown)(...args);
      };
    }
  }
  return { plugin, calls: () => calls };
}

describe('environmentPolicies.denyKinds on query', () => {
  it('refuses a datasource by its own env, and touches the plugin not at all', async () => {
    // arrange
    writePolicies({ prod: { denyKinds: ['fake'] } });
    const counted = countingPlugin();
    const ctx = contextWith(counted.plugin);

    // act
    const outcome = await executeQuery(queryRequest({ env: 'qa' }), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined });

    // assert
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.message).toMatch(/denyKinds/);
    expect(outcome.message).toMatch(/'prod'/);
    expect(counted.calls()).toBe(0);
  });

  it('ignores a deny set only for the env named on the request', async () => {
    // arrange
    writePolicies({ qa: { denyKinds: ['fake'] } });
    const ctx = contextWith(fakePlugin());

    // act
    const outcome = await executeQuery(queryRequest({ env: 'qa' }), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined });

    // assert
    expect(outcome.ok).toBe(true);
  });

  it('runs a datasource whose kind is not in its env denyKinds', async () => {
    // arrange
    writePolicies({ prod: { denyKinds: ['kafka'] } });
    const ctx = contextWith(fakePlugin());

    // act
    const outcome = await executeQuery(queryRequest({ env: 'qa' }), { ctx, report: silentQueryReport, signal: undefined, acquireQuerySlot: undefined });

    // assert
    expect(outcome.ok).toBe(true);
  });
});
