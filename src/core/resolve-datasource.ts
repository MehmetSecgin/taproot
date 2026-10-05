import type { AppContext } from './app.js';
import { defaultDatasourceName } from './app.js';
import { bootstrapDatasource, saveKbBootstrapCandidate } from './bootstrap.js';
import { discoverKubernetesTargets, discoverTeleportTargets, inferDatabaseCandidates } from './discovery.js';
import { AccessMethod } from '../types/core.js';
import type { DatasourceProfile, EnvironmentPolicy } from '../types/core.js';
import { str } from './strings.js';

export type ResolutionSource = 'explicit' | 'store' | 'learning' | 'kb' | 'unknown';

export interface ResolutionAsk {
  rawDs?: string;
  env?: string;
  namespace?: string;
  service?: string;
}

function splitDatasourceName(rawDs: string, services: string[]): { service: string; env: string } | undefined {
  const parts = rawDs.split('-');
  for (const service of [...services].sort((a, b) => b.length - a.length)) {
    const want = service.split('-');
    for (let i = 0; i + want.length <= parts.length; i++) {
      if (want.every((w, j) => parts[i + j] === w)) return { service, env: parts.slice(0, i).join('-') };
    }
  }
  return undefined;
}

export function describeResolutionFailure(profiles: DatasourceProfile[], ask: ResolutionAsk): string {
  const rawDs = str(ask.rawDs).trim();
  const known = [...new Set(profiles.map((p) => str(p.service).trim()).filter(Boolean))];
  const fromName = rawDs ? splitDatasourceName(rawDs, known) : undefined;
  const service = str(ask.service).trim() || fromName?.service || '';
  const env = str(ask.env).trim() || fromName?.env || '';
  const namespace = str(ask.namespace).trim();
  const asked = rawDs ? `datasource '${rawDs}'` : `env=${env || '?'} service=${service || '?'}`;
  const head = `Datasource resolution failed: no profile for ${asked}.`;
  const matches = service ? profiles.filter((p) => str(p.service).trim() === service) : [];
  if (!matches.length) return `${head} Use --datasource or --env+--service; list profiles with taproot --json datasource list.`;
  const names = matches.map((p) => p.name).sort();
  const shown = names.slice(0, 6).join(', ') + (names.length > 6 ? ` (+${names.length - 6})` : '');
  const envLabel = (p: DatasourceProfile) => str(p.env).trim() + (str(p.namespace).trim() ? `/${str(p.namespace).trim()}` : '');
  const envs = [...new Set(matches.map(envLabel).filter(Boolean))].sort().join(', ');
  const inEnv = (p: DatasourceProfile) => {
    const ns = str(p.namespace).trim();
    if (p.env === env) return !namespace || ns === namespace;
    return !namespace && Boolean(ns) && `${p.env}-${ns}` === env;
  };
  const where = `env '${env}'${namespace ? ` namespace '${namespace}'` : ''}`;
  const missing = env && !matches.some(inEnv) ? ` No profile in ${where}; add one with taproot datasource add.` : '';
  return `${head} Profiles for service '${service}': ${shown} (envs: ${envs}).${missing}`;
}

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
