import type { AppContext } from './app.js';
import { defaultDatasourceName } from './app.js';
import { saveKbBootstrapCandidate } from './bootstrap.js';
import { levenshtein, suggestNames } from './grpc-introspect.js';
import { discoverKubernetesTargets } from './discovery.js';
import { AccessMethod, DatasourceKind } from '../types/core.js';
import type { DatasourceProfile, EnvironmentPolicy } from '../types/core.js';
import { str } from './strings.js';

export type ResolutionSource = 'explicit' | 'store' | 'kb' | 'unknown';

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

function closeDatasourceNames(rawDs: string, names: string[]): string[] {
  const q = rawDs.toLowerCase();
  const maxDistance = Math.max(2, Math.floor(q.length / 3));
  const demoted = (n: string) => !q.startsWith('prod') && n.toLowerCase().startsWith('prod');
  return suggestNames(rawDs, names, names.length)
    .filter((n) => n.toLowerCase().includes(q) || levenshtein(q, n.toLowerCase()) <= maxDistance)
    .sort((a, b) => Number(demoted(a)) - Number(demoted(b)))
    .slice(0, 3);
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
  const firstToken = rawDs.split(/\s+/)[0];
  if (firstToken !== rawDs && profiles.some((p) => p.name === firstToken)) {
    return `${head} Datasource value contains spaces; did you mean '${firstToken}'?`;
  }
  const matches = service ? profiles.filter((p) => str(p.service).trim() === service) : [];
  if (!matches.length) {
    const close = rawDs ? closeDatasourceNames(rawDs, profiles.map((p) => p.name)) : [];
    const hint = close.length ? ` Did you mean ${close.join(', ')}?` : '';
    return `${head}${hint} Use --datasource or --env+--service; list profiles with taproot datasource list.`;
  }
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

const SQL_KINDS: DatasourceKind[] = [DatasourceKind.Mysql, DatasourceKind.TeleportMysql];
const GRPC_CALL_RE = /^[\w.]+\/\w+$/;
const SQL_STATEMENT_RE = /^(select|show|with|describe|desc|explain|insert|update|delete|replace)\b/i;

export function datasourceKindsForQuery(query: string): DatasourceKind[] {
  const text = str(query).trim();
  if (GRPC_CALL_RE.test(text)) return [DatasourceKind.Grpc];
  if (SQL_STATEMENT_RE.test(text)) return SQL_KINDS;
  return [];
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
  query?: string;
  allowDiscovery: boolean;
  policy: EnvironmentPolicy;
}

function preferredAccessMethods(policy: EnvironmentPolicy, kbAccessMethod?: string): string[] {
  const out = [...policy.preferredAccessMethods];
  if (kbAccessMethod && !out.includes(kbAccessMethod)) out.push(kbAccessMethod);
  return out.filter(Boolean);
}

function discoverTargets(input: { env: string; service: string; accessMethods: string[]; namespace?: string; policy: EnvironmentPolicy }): string[] {
  if (!input.accessMethods.some((method) => str(method).trim().toLowerCase() === AccessMethod.QaPortforward)) return [];
  return discoverKubernetesTargets(String(input.namespace || 'default'), input.service, input.env, input.policy);
}

export async function resolveDatasourceWithFallbacks(input: ResolveWithFallbacksInput): Promise<DatasourceResolution> {
  const { ctx, rawDs, optsEnv, env, namespace, service, allowDiscovery, policy } = input;
  const verboseLogs: string[] = [];
  const preferKinds = datasourceKindsForQuery(str(input.query));

  let datasource = rawDs ? ctx.datasourceStore.get(rawDs) : undefined;
  let source: ResolutionSource = datasource ? 'explicit' : 'unknown';

  if (!datasource && optsEnv && service) {
    datasource = ctx.datasourceStore.resolveByEnvService(optsEnv, service, namespace || undefined, preferKinds);
    if (datasource) source = 'store';
  }
  if (!datasource && env && service) {
    datasource = ctx.datasourceStore.resolveByEnvService(env, service, namespace || undefined, preferKinds);
    if (datasource) source = 'store';
  }
  if (!datasource && env && service) {
    const kb = ctx.kbStore.resolveConnection(service, env, namespace || undefined);
    datasource = kb ? await saveKbBootstrapCandidate(ctx, env, service, defaultDatasourceName(env, service, str(kb.namespace || namespace).trim() || undefined), kb) : undefined;
    if (datasource) {
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
      const database = str(kb?.database || service.replace(/-/g, '_'));
      const dbUser = str(kb?.db_user);
      const syntheticKb = {
        access_method: AccessMethod.QaPortforward,
        database,
        db_user: dbUser,
        target,
        namespace: targetNamespace,
        ...(kb || {}),
      };
      datasource = await saveKbBootstrapCandidate(ctx, env, service, rawDs || defaultDatasourceName(env, service, targetNamespace), syntheticKb, {
        targetOverride: target,
        tags: ['discovery-derived'],
        confidence: 0.6,
      });
      if (datasource) source = 'kb';
    }
  }

  return { datasource, source, verboseLogs };
}
