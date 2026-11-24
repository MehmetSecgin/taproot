import type { AppContext } from '../core/app.js';
import { saveKbDatasource } from '../core/bootstrap.js';
import { normalizeNamespace, normalizeService } from '../core/naming.js';
import { emptyToUndefined } from '../core/text-presence.js';
import { describeTarget } from './describe-target.js';

export type DatasourceResolveOptions = { env: string; namespace?: string; service: string };

type NormalizedTarget = { env: string; namespace?: string; service: string };

function normalizedTarget(ctx: AppContext, opts: DatasourceResolveOptions): NormalizedTarget {
  return {
    env: opts.env,
    namespace: emptyToUndefined(normalizeNamespace(opts.namespace)),
    service: normalizeService(opts.service, ctx.runtimeConfigStore.serviceAliases()),
  };
}

async function profileFromKb(ctx: AppContext, target: NormalizedTarget, kbConnection: Record<string, unknown>): Promise<unknown> {
  const profile = await saveKbDatasource(ctx, { ...target, kb: kbConnection });
  if (!profile) {
    throw new Error(`KB connection could not be converted into a datasource profile for ${describeTarget(target)}`);
  }
  return profile;
}

export async function resolveDatasourceProfile(ctx: AppContext, opts: DatasourceResolveOptions): Promise<{ source: string; profile: unknown }> {
  const target = normalizedTarget(ctx, opts);
  const fromStore = ctx.datasourceStore.resolveByEnvService({ env: target.env, namespace: target.namespace, service: target.service, preferKinds: [] });
  if (fromStore) {
    return { source: 'datasource-store', profile: fromStore };
  }
  const kbConnection = ctx.kbStore.resolveConnection(target.service, target.env, target.namespace);
  if (!kbConnection) {
    throw new Error(`No datasource profile found for ${describeTarget(target)}`);
  }
  return { source: 'kb', profile: await profileFromKb(ctx, target, kbConnection) };
}
