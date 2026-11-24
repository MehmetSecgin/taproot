import type { AppContext } from './app.js';
import { defaultDatasourceName } from './naming.js';
import { requireAccessMethod, saveKbBootstrapCandidate, saveKbDatasource } from './bootstrap.js';
import { AccessMethod, DatasourceKind, SQL_DATASOURCE_KINDS } from '../types/datasource.js';
import type { DatasourceProfile } from '../types/datasource.js';
import type { EnvironmentPolicy } from '../store/runtime-config.js';
import type { TargetSearch } from './kubernetes-target-discovery.js';
import { emptyToUndefined, firstNonEmpty, textUnlessFalsy } from './text-presence.js';

export type TargetDiscovery = (search: TargetSearch) => string[];

type ResolutionSource = 'explicit' | 'store' | 'kb' | 'unknown';

type DatasourceResolution = {
  datasource?: DatasourceProfile;
  source: ResolutionSource;
  verboseLogs: string[];
};

type ResolveWithFallbacksInput = {
  ctx: AppContext;
  datasourceName?: string;
  explicitEnvFlag?: string;
  effectiveEnv: string;
  namespace?: string;
  service: string;
  query?: string;
  discover: TargetDiscovery | undefined;
  policy: EnvironmentPolicy;
};

type KbConnection = Record<string, unknown> | null;

type DiscoveredTarget = { kb: KbConnection; target: string; namespace: string };

const GRPC_CALL_RE = /^[\w.]+\/\w+$/u;
const SQL_STATEMENT_RE = /^(?:select|show|with|describe|desc|explain|insert|update|delete|replace)\b/iu;
const DEFAULT_NAMESPACE = 'default';

export function datasourceKindsForQuery(query: string): string[] {
  const text = textUnlessFalsy(query).trim();
  if (GRPC_CALL_RE.test(text)) {
    return [DatasourceKind.Grpc];
  }
  return SQL_STATEMENT_RE.test(text) ? [...SQL_DATASOURCE_KINDS] : [];
}

function resolveFromStore(input: ResolveWithFallbacksInput): { datasource: DatasourceProfile; source: ResolutionSource } | undefined {
  const { ctx, datasourceName, explicitEnvFlag, effectiveEnv, namespace, service } = input;
  const explicit = datasourceName === undefined || datasourceName === '' ? undefined : ctx.datasourceStore.get(datasourceName);
  if (explicit !== undefined) {
    return { datasource: explicit, source: 'explicit' };
  }
  const preferredKinds = datasourceKindsForQuery(textUnlessFalsy(input.query));
  for (const env of [explicitEnvFlag, effectiveEnv]) {
    const datasource = env === undefined || env === '' || service === ''
      ? undefined
      : ctx.datasourceStore.resolveByEnvService({ env, namespace: emptyToUndefined(namespace), service, preferKinds: preferredKinds });
    if (datasource !== undefined) {
      return { datasource, source: 'store' };
    }
  }
  return undefined;
}

async function bootstrapFromKb(input: ResolveWithFallbacksInput, kb: KbConnection): Promise<DatasourceProfile | undefined> {
  if (kb === null) {
    return undefined;
  }
  const { ctx, effectiveEnv, namespace, service } = input;
  return saveKbDatasource(ctx, { env: effectiveEnv, service, namespace, kb });
}

function preferredAccessMethods(env: string, policy: EnvironmentPolicy, kbAccessMethod: string): string[] {
  const accessMethods: string[] = policy.preferredAccessMethods.map((method) =>
    requireAccessMethod(textUnlessFalsy(method).trim().toLowerCase(), `environmentPolicies.${env}.preferredAccessMethods`),
  );
  return kbAccessMethod !== '' && !accessMethods.includes(kbAccessMethod) ? [...accessMethods, kbAccessMethod] : accessMethods;
}

function syntheticKbConnection(service: string, discovered: DiscoveredTarget): Record<string, unknown> {
  const { kb, target, namespace } = discovered;
  return {
    access_method: AccessMethod.KubectlPortforward,
    database: firstNonEmpty(textUnlessFalsy(kb?.database), service.replaceAll('-', '_')) ?? '',
    db_user: textUnlessFalsy(kb?.db_user),
    target,
    namespace,
    ...kb,
  };
}

async function bootstrapFromDiscovery(input: ResolveWithFallbacksInput, discover: TargetDiscovery, kb: KbConnection): Promise<DatasourceProfile | undefined> {
  const { ctx, datasourceName, effectiveEnv, service, policy } = input;
  const targetNamespace = firstNonEmpty(textUnlessFalsy(kb?.namespace), input.namespace, DEFAULT_NAMESPACE) ?? '';
  const accessMethods = preferredAccessMethods(effectiveEnv, policy, textUnlessFalsy(kb?.access_method).trim().toLowerCase());
  const targets = accessMethods.includes(AccessMethod.KubectlPortforward) ? discover({ namespace: targetNamespace, service, env: effectiveEnv, policy }) : [];
  if (targets.length === 0) {
    return undefined;
  }
  const [target] = targets;
  const name = firstNonEmpty(datasourceName, defaultDatasourceName(effectiveEnv, service, targetNamespace)) ?? '';
  return saveKbBootstrapCandidate(ctx, {
    env: effectiveEnv,
    service,
    datasourceName: name,
    kb: syntheticKbConnection(service, { kb, target, namespace: targetNamespace }),
    options: { targetOverride: target, tags: ['discovery-derived'] },
  });
}

async function resolveFromKbOrDiscovery(input: ResolveWithFallbacksInput): Promise<DatasourceResolution> {
  const kb = input.ctx.kbStore.resolveConnection(input.service, input.effectiveEnv, emptyToUndefined(input.namespace));
  const fromKb = await bootstrapFromKb(input, kb);
  if (fromKb !== undefined) {
    return { datasource: fromKb, source: 'kb', verboseLogs: [`auto-bootstrapped datasource from KB (${fromKb.name})`] };
  }
  const discovered = input.discover === undefined ? undefined : await bootstrapFromDiscovery(input, input.discover, kb);
  return { datasource: discovered, source: discovered === undefined ? 'unknown' : 'kb', verboseLogs: [] };
}

export async function resolveDatasourceWithFallbacks(input: ResolveWithFallbacksInput): Promise<DatasourceResolution> {
  const stored = resolveFromStore(input);
  if (stored !== undefined) {
    return { ...stored, verboseLogs: [] };
  }
  if (input.effectiveEnv === '' || input.service === '') {
    return { datasource: undefined, source: 'unknown', verboseLogs: [] };
  }
  return resolveFromKbOrDiscovery(input);
}
