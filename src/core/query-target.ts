import type { DatasourceProfile } from '../types/datasource.js';
import type { AppContext } from './app.js';
import { normalizeNamespace, normalizeService } from './naming.js';
import { firstNonEmpty, isNonEmpty, textUnlessFalsy } from './text-presence.js';

export type QueryTarget = {
  env: string;
  namespace: string;
  service: string;
  explicitProfile?: DatasourceProfile;
};

const ENV_SERVICE_ALIAS = /^(?<env>[a-z0-9]+)-(?<service>[a-z0-9-]+)$/u;

function parseEnvServiceAlias(datasourceName: string, aliases: Record<string, string>): { env: string; service: string } | undefined {
  const groups = ENV_SERVICE_ALIAS.exec(datasourceName.trim().toLowerCase())?.groups;
  if (groups?.env === undefined || groups.service === undefined) {
    return undefined;
  }
  return { env: groups.env, service: normalizeService(groups.service, aliases) };
}

export function deriveQueryTarget(
  ctx: AppContext,
  input: { datasource?: string; env?: string; namespace?: string; service?: string },
): QueryTarget {
  const aliases = ctx.runtimeConfigStore.serviceAliases();
  const explicitProfile = isNonEmpty(input.datasource) ? ctx.datasourceStore.get(input.datasource) : undefined;
  const alias = explicitProfile ? undefined : parseEnvServiceAlias(textUnlessFalsy(input.datasource), aliases);
  return {
    env: textUnlessFalsy(firstNonEmpty(input.env, explicitProfile?.env, alias?.env)).trim(),
    namespace: normalizeNamespace(textUnlessFalsy(firstNonEmpty(input.namespace, explicitProfile?.namespace))),
    service: normalizeService(firstNonEmpty(input.service, explicitProfile?.service, alias?.service) ?? '', aliases),
    explicitProfile,
  };
}
