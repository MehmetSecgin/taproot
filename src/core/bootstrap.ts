import type { AppContext } from './app.js';
import { defaultDatasourceName } from './naming.js';
import { blockingDatasourceKbConflicts } from './conflicts.js';
import type { AccessMethod, DatasourceProfile } from '../types/datasource.js';
import { emptyToUndefined, firstNonEmpty, isNonEmpty, textUnlessFalsy } from './text-presence.js';
import { badInput } from './taproot-error.js';
import { KB_ACCESS_METHODS, buildKbDatasourceCandidate, isKbAccessMethod } from './kb-datasource-candidates.js';
import type { CredentialDefaultSpec, KbDatasourceCandidate, KbEntry } from './kb-datasource-candidates.js';

type BootstrapResult = {
  profile: DatasourceProfile;
  source: 'store-existing' | 'kb-bootstrap' | 'kb-repaired';
  credentialRefs: string[];
};

type KbBootstrapOptions = {
  targetOverride?: string;
  tags?: string[];
};

type KbLookup = {
  env: string;
  service: string;
  namespace?: string;
};

type KbCandidateRequest = {
  env: string;
  service: string;
  datasourceName: string;
  kb: KbEntry;
  options?: KbBootstrapOptions;
};

const DEFAULT_CANDIDATE_TAGS = ['auto-bootstrap', 'kb-derived'];

function credentialRefsOf(profile: DatasourceProfile): string[] {
  const refs = new Set<string>();
  if (profile.credentialRef !== '') {
    refs.add(profile.credentialRef);
  }
  for (const hint of Object.values(profile.resolverHints ?? {})) {
    const ref = textUnlessFalsy(hint).trim();
    if (ref !== '') {
      refs.add(ref);
    }
  }
  return [...refs];
}

async function ensureCredentialDefaults(ctx: AppContext, spec: CredentialDefaultSpec): Promise<void> {
  const current = await ctx.credentialStore.get(spec.ref);
  const overwrite = spec.overwrite ?? false;
  const merged = overwrite ? { ...current, ...spec.defaults } : { ...spec.defaults, ...current };
  const changed = Object.entries(spec.defaults).some(([key, value]) =>
    overwrite ? current[key] !== value : !isNonEmpty(current[key]) && isNonEmpty(value),
  );
  if (changed) {
    await ctx.credentialStore.set(spec.ref, merged);
  }
}

export function requireAccessMethod(value: string, where: string): AccessMethod {
  if (isKbAccessMethod(value)) {
    return value;
  }
  throw badInput(`Unknown access method '${value}' in ${where}. Known: ${KB_ACCESS_METHODS.join(', ')}.`);
}

function buildKbCandidate(request: KbCandidateRequest): KbDatasourceCandidate | undefined {
  const { env, service, datasourceName, kb, options } = request;
  const accessMethod = textUnlessFalsy(kb.access_method).toLowerCase();
  if (accessMethod === '') {
    return undefined;
  }
  const validatedMethod = requireAccessMethod(accessMethod, `the KB entry for env=${env} service=${service}`);
  const targetOverride = options?.targetOverride;
  return buildKbDatasourceCandidate(validatedMethod, {
    env,
    service,
    datasourceName,
    kb,
    database: textUnlessFalsy(kb.database),
    dbUser: textUnlessFalsy(kb.db_user),
    target: textUnlessFalsy(isNonEmpty(targetOverride) ? targetOverride : kb.target),
    credentialRef: env,
    tags: options?.tags ?? DEFAULT_CANDIDATE_TAGS,
    namespace: emptyToUndefined(textUnlessFalsy(kb.namespace).trim()),
  });
}

async function persistCandidate(ctx: AppContext, candidate: KbDatasourceCandidate): Promise<DatasourceProfile> {
  for (const spec of candidate.credentialDefaults) {
    await ensureCredentialDefaults(ctx, spec);
  }
  return ctx.datasourceStore.save(candidate.profile);
}

export async function saveKbBootstrapCandidate(ctx: AppContext, request: KbCandidateRequest): Promise<DatasourceProfile | undefined> {
  const candidate = buildKbCandidate(request);
  if (!candidate) {
    return undefined;
  }
  return persistCandidate(ctx, candidate);
}

function kbDatasourceName(lookup: KbLookup, kb: KbEntry): string {
  return defaultDatasourceName(lookup.env, lookup.service, firstNonEmpty(textUnlessFalsy(kb.namespace), lookup.namespace));
}

export async function saveKbDatasource(ctx: AppContext, found: KbLookup & { kb: KbEntry }): Promise<DatasourceProfile | undefined> {
  const { env, service, kb } = found;
  return saveKbBootstrapCandidate(ctx, { env, service, datasourceName: kbDatasourceName(found, kb), kb });
}

function loadKbCandidate(ctx: AppContext, lookup: KbLookup): KbDatasourceCandidate | undefined {
  const { env, service, namespace } = lookup;
  const kb = ctx.kbStore.resolveConnection(service, env, namespace);
  if (!kb) {
    return undefined;
  }
  return buildKbCandidate({ env, service, datasourceName: kbDatasourceName(lookup, kb), kb });
}

export async function reconcileDatasource(ctx: AppContext, lookup: KbLookup): Promise<BootstrapResult | undefined> {
  const candidate = loadKbCandidate(ctx, lookup);
  if (!candidate) {
    return undefined;
  }
  const { env, service, namespace } = lookup;
  const existing = ctx.datasourceStore.resolveByEnvService({ env, namespace, service, preferKinds: [] });
  if (existing && blockingDatasourceKbConflicts(existing, candidate.kb).length === 0) {
    return { profile: existing, source: 'store-existing', credentialRefs: credentialRefsOf(existing) };
  }
  const profile = await persistCandidate(ctx, candidate);
  return { profile, source: existing ? 'kb-repaired' : 'kb-bootstrap', credentialRefs: credentialRefsOf(profile) };
}
