import { afterEach, beforeEach } from 'vitest';
import type { TargetDiscovery } from '../../src/core/resolve-datasource.js';
import { queryDatasourceResolver } from '../../src/core/resolve-query-datasource.js';
import { restoreProcessEnv, setupQueryState } from './query-state.js';

const NO_TARGET_DISCOVERY: TargetDiscovery | undefined = undefined;

export const storeResolver = queryDatasourceResolver(NO_TARGET_DISCOVERY);

export function useQueryStateRoot(): () => string {
  const current = { stateRoot: '' };
  beforeEach(async () => {
    current.stateRoot = await setupQueryState();
  });

  afterEach(() => {
    restoreProcessEnv();
  });

  return () => current.stateRoot;
}

export function useDefaultQueryState(): void {
  useQueryStateRoot();
}
