import type { AppContext } from './app.js';
import { defaultDatasourceName } from './app.js';
import { bootstrapDatasource } from './bootstrap.js';
import type { DatasourceProfile } from '../types/core.js';

export type ResolutionSource = 'explicit' | 'store' | 'learning' | 'kb' | 'unknown';

export interface CanonicalResolution {
  datasource?: DatasourceProfile;
  source: ResolutionSource;
}

export async function resolveCanonicalDatasource(input: {
  ctx: AppContext;
  rawDs: string;
  env: string;
  namespace?: string;
  service: string;
}): Promise<CanonicalResolution> {
  const { ctx, rawDs, env, namespace, service } = input;
  const explicit = rawDs ? ctx.datasourceStore.get(rawDs) : undefined;
  if (explicit) return { datasource: explicit, source: 'explicit' };

  if (env && service) {
    const fromStore = ctx.datasourceStore.resolveByEnvService(env, service, namespace || undefined);
    if (fromStore) return { datasource: fromStore, source: 'store' };

    const bootstrapped = await bootstrapDatasource(
      ctx,
      env,
      service,
      rawDs || defaultDatasourceName(env, service, namespace || undefined),
      namespace || undefined,
    );
    if (bootstrapped) return { datasource: bootstrapped.profile, source: 'kb' };
  }

  return { datasource: undefined, source: 'unknown' };
}
