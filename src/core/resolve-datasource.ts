import type { AppContext } from './app.js';
import { defaultDatasourceName } from './app.js';
import { bootstrapDatasource, saveKbBootstrapCandidate } from './bootstrap.js';
import { discoverKubernetesTargets, discoverTeleportTargets, inferDatabaseCandidates } from './discovery.js';
import { AccessMethod } from '../types/core.js';
import type { DatasourceProfile, EnvironmentPolicy } from '../types/core.js';
import { str } from './strings.js';

export type ResolutionSource = 'explicit' | 'store' | 'learning' | 'kb' | 'unknown';

export interface DatasourceResolution {
  datasource?: DatasourceProfile;
  source: ResolutionSource;
  verboseLogs: string[];
}

export interface ResolveWithFallbacksInput {
  ctx: AppContext;
  rawDs?: string;
  optsEnv?: string;
  env: string;
  namespace?: string;
  service: string;
  allowDiscovery: boolean;
  deterministicRequired: boolean;
  policy: EnvironmentPolicy;
}

function preferredAccessMethods(policy: EnvironmentPolicy, kbAccessMethod?: string): string[] {
  const out = [...policy.preferredAccessMethods];
  if (kbAccessMethod && !out.includes(kbAccessMethod)) out.push(kbAccessMethod);
  return out.filter(Boolean);
}

function discoverTargets(input: { env: string; service: string; accessMethods: string[]; namespace?: string; policy: EnvironmentPolicy }): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const method of input.accessMethods) {
    const current = str(method).trim().toLowerCase();
    let next: string[] = [];
    if (current === AccessMethod.QaPortforward) {
      next = discoverKubernetesTargets(String(input.namespace || 'default'), input.service, input.env, input.policy);
    } else if (current === AccessMethod.Tsh) {
      next = discoverTeleportTargets(input.service, input.env, input.policy);
    }
    for (const target of next) {
      if (seen.has(target)) continue;
      seen.add(target);
      out.push(target);
    }
  }
  return out;
}

export async function resolveDatasourceWithFallbacks(input: ResolveWithFallbacksInput): Promise<DatasourceResolution> {
  const { ctx, rawDs, optsEnv, env, namespace, service, allowDiscovery, deterministicRequired, policy } = input;
  const verboseLogs: string[] = [];

  let datasource = rawDs ? ctx.datasourceStore.get(rawDs) : undefined;
  let source: ResolutionSource = datasource ? 'explicit' : 'unknown';

  if (!datasource && optsEnv && service) {
    datasource = ctx.datasourceStore.resolveByEnvService(optsEnv, service, namespace || undefined);
    if (datasource) source = 'store';
  }
  if (!datasource && env && service) {
    datasource = ctx.datasourceStore.resolveByEnvService(env, service, namespace || undefined);
    if (datasource) source = 'store';
  }
  if (!datasource && env && service && (!deterministicRequired || allowDiscovery)) {
    const learned = ctx.learningStore.resolveConnection(env, service, namespace || undefined);
    if (learned) {
      datasource = ctx.datasourceStore.save({
        name: learned.datasourceName,
        kind: learned.kind,
        env: learned.env,
        namespace: learned.namespace,
        service: learned.service,
        tags: ['learning-derived'],
        connection: learned.connection,
        credentialRef: learned.credentialRef,
        connectors: learned.connectors,
        policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
        resolverHints: learned.resolverHints || {},
        updatedAt: new Date().toISOString(),
        confidence: learned.confidence,
      });
      source = 'learning';
    }
  }
  if (!datasource && env && service) {
    const bootstrapped = await bootstrapDatasource(ctx, env, service, rawDs || defaultDatasourceName(env, service, namespace || undefined), namespace || undefined);
    if (bootstrapped) {
      datasource = bootstrapped.profile;
      source = 'kb';
      verboseLogs.push(`auto-bootstrapped datasource from KB (${datasource.name})`);
    }
  }
  if (!datasource && env && service && allowDiscovery) {
    const kb = ctx.kbStore.resolveConnection(service, env, namespace || undefined);
    const kbAccessMethod = str(kb?.access_method).trim().toLowerCase();
    const targetNamespace = String(kb?.namespace || namespace || 'default');
    const accessMethods = preferredAccessMethods(policy, kbAccessMethod);
    const targets = discoverTargets({ env, service, accessMethods, namespace: targetNamespace, policy });
    if (targets.length) {
      const target = targets[0];
      const database = str(kb?.database || inferDatabaseCandidates(service)[0]);
      const dbUser = str(kb?.db_user);
      const engine = policy.targetPreference.find((item) => target.toLowerCase().includes(item.toLowerCase()))
        || (String(kb?.engine || 'mysql').toLowerCase().includes('postgres') ? 'postgres' : 'mysql');
      const accessMethod = accessMethods[0] || kbAccessMethod;
      const syntheticKb = {
        access_method: accessMethod,
        engine,
        database,
        db_user: dbUser,
        target,
        namespace: targetNamespace,
        ...(kb || {}),
      };
      if (accessMethod === AccessMethod.Tsh || accessMethod === AccessMethod.QaPortforward) {
        datasource = await saveKbBootstrapCandidate(ctx, env, service, rawDs || defaultDatasourceName(env, service, targetNamespace), syntheticKb, {
          targetOverride: target,
          tags: ['discovery-derived'],
          confidence: 0.6,
        });
        if (datasource) source = 'kb';
      }
    }
  }

  return { datasource, source, verboseLogs };
}
