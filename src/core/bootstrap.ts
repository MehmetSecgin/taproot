import type { AppContext } from './app.js';
import { defaultDatasourceName } from './naming.js';
import { criticalDatasourceKbConflicts } from './conflicts.js';
import { kubectlPortforwardLocalPort } from './kubectl-portforward.js';
import { nowIso } from './time.js';
import { AccessMethod, DatasourceKind } from '../types/core.js';
import type { DatasourceProfile } from '../types/core.js';
import { str } from './strings.js';
import { badInput } from './error-classification.js';

export interface BootstrapResult {
  profile: DatasourceProfile;
  source: 'store-existing' | 'kb-bootstrap' | 'kb-repaired';
  credentialRefs: string[];
}

interface CredentialDefaultSpec {
  ref: string;
  defaults: Record<string, string>;
  overwrite?: boolean;
}

interface KbBootstrapCandidate {
  kb: Record<string, unknown>;
  profile: DatasourceProfile;
  credentialDefaults: CredentialDefaultSpec[];
}

interface KbBootstrapOptions {
  targetOverride?: string;
  tags?: string[];
}

function collectBootstrapMetadata(profile: DatasourceProfile): Pick<BootstrapResult, 'credentialRefs'> {
  const refs = new Set<string>();
  if (profile.credentialRef) refs.add(profile.credentialRef);
  for (const value of Object.values(profile.resolverHints || {})) {
    const ref = str(value).trim();
    if (ref) refs.add(ref);
  }
  return { credentialRefs: [...refs] };
}

async function ensureCredentialDefaults(
  ctx: AppContext,
  ref: string,
  defaults: Record<string, string>,
  overwrite = false,
): Promise<void> {
  const current = await ctx.credentialStore.get(ref);
  const merged = overwrite ? { ...current, ...defaults } : { ...defaults, ...current };
  const changed = overwrite
    ? Object.keys(defaults).some((k) => current[k] !== defaults[k])
    : Object.keys(defaults).some((k) => !current[k] && defaults[k]);
  if (changed) await ctx.credentialStore.set(ref, merged);
}

interface BootstrapContext {
  env: string;
  service: string;
  datasourceName: string;
  kb: Record<string, unknown>;
  database: string;
  dbUser: string;
  target: string;
  credentialRef: string;
  tags: string[];
  namespace?: string;
}

function buildKubectlPortforwardCandidate(c: BootstrapContext): KbBootstrapCandidate {
  const effectiveNamespace = String(c.namespace || 'default');
  const context = String(c.kb.k8s_context || c.env || effectiveNamespace);
  const localPort = kubectlPortforwardLocalPort(c.env, c.namespace, c.service);
  const logFile = `/tmp/taproot-pf-${c.env}-${c.service}.log`;
  const forwardArgs = `--context ${context} -n ${effectiveNamespace} port-forward svc/${c.target} ${localPort}:`;
  const listenerPid = `$(lsof -tiTCP:${localPort} -sTCP:LISTEN | head -n 1)`;
  const statusCommand = `ps -o command= -p "${listenerPid}" 2>/dev/null | grep -qF -- '${forwardArgs}'`;
  const connectCommand = `${statusCommand} || (svc_port=$(kubectl --context ${context} -n ${effectiveNamespace} get svc/${c.target} -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || echo 4000); nohup kubectl ${forwardArgs}$svc_port >${logFile} 2>&1 & for _ in 1 2 3 4 5; do ${statusCommand} && break; sleep 1; done; ${statusCommand})`;
  const kpfRef = `kpf:${c.env}:${c.namespace || 'default'}:${c.service}`;
  return {
    kb: c.kb,
    profile: {
      name: c.datasourceName,
      kind: DatasourceKind.Mysql,
      env: c.env,
      namespace: c.namespace,
      service: c.service,
      tags: c.tags,
      connection: { host: '127.0.0.1', port: localPort, database: c.database },
      credentialRef: c.credentialRef,
      connectors: ['kubectl-portforward'],
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      resolverHints: {
        'kubectl-portforwardCredentialRef': kpfRef,
      },
      updatedAt: nowIso(),
    },
    credentialDefaults: [
      { ref: c.credentialRef, defaults: { user: c.dbUser || 'root' } },
      { ref: kpfRef, defaults: { statusCommand, connectCommand }, overwrite: true },
    ],
  };
}

function buildNativeCandidate(c: BootstrapContext): KbBootstrapCandidate | undefined {
  const host = str(c.kb.host).trim();
  if (!host) return undefined;
  const port = Number(c.kb.port || 0) || 3306;
  return {
    kb: c.kb,
    profile: {
      name: c.datasourceName,
      kind: DatasourceKind.Mysql,
      env: c.env,
      namespace: c.namespace,
      service: c.service,
      tags: c.tags,
      connection: { host, port, database: c.database },
      credentialRef: c.credentialRef,
      connectors: [],
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      resolverHints: {},
      updatedAt: nowIso(),
    },
    credentialDefaults: [{ ref: c.credentialRef, defaults: { user: c.dbUser || 'root' } }],
  };
}

function buildTshCandidate(c: BootstrapContext): KbBootstrapCandidate {
  const tshRef = `tsh:${c.env}`;
  return {
    kb: c.kb,
    profile: {
      name: c.datasourceName,
      kind: DatasourceKind.TeleportMysql,
      env: c.env,
      namespace: c.namespace,
      service: c.service,
      tags: c.tags,
      connection: { database: c.database, target: c.target },
      credentialRef: c.credentialRef,
      connectors: ['teleport'],
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      resolverHints: {
        teleportCredentialRef: tshRef,
        ...(c.dbUser ? { dbUser: c.dbUser } : {}),
      },
      updatedAt: nowIso(),
    },
    credentialDefaults: [
      { ref: c.credentialRef, defaults: { dbUser: c.dbUser } },
      { ref: tshRef, defaults: { statusCommand: 'tsh status' } },
    ],
  };
}

const CANDIDATE_BUILDERS: Record<AccessMethod, (c: BootstrapContext) => KbBootstrapCandidate | undefined> = {
  [AccessMethod.KubectlPortforward]: buildKubectlPortforwardCandidate,
  [AccessMethod.Native]: buildNativeCandidate,
  [AccessMethod.Tsh]: buildTshCandidate,
};

export function requireAccessMethod(value: string, where: string): AccessMethod {
  if (Object.hasOwn(CANDIDATE_BUILDERS, value)) return value as AccessMethod;
  throw badInput(`Unknown access method '${value}' in ${where}. Known: ${Object.keys(CANDIDATE_BUILDERS).join(', ')}.`);
}

function buildKbBootstrapCandidate(
  env: string,
  service: string,
  datasourceName: string,
  kb: Record<string, unknown>,
  options?: KbBootstrapOptions,
): KbBootstrapCandidate | undefined {
  const accessMethod = str(kb.access_method).toLowerCase();
  if (!accessMethod) return undefined;
  const build = CANDIDATE_BUILDERS[requireAccessMethod(accessMethod, `the KB entry for env=${env} service=${service}`)];
  const c: BootstrapContext = {
    env,
    service,
    datasourceName,
    kb,
    database: str(kb.database),
    dbUser: str(kb.db_user),
    target: str(options?.targetOverride || kb.target),
    credentialRef: env,
    tags: options?.tags || ['auto-bootstrap', 'kb-derived'],
    namespace: str(kb.namespace).trim() || undefined,
  };
  return build(c);
}

export async function saveKbBootstrapCandidate(
  ctx: AppContext,
  env: string,
  service: string,
  datasourceName: string,
  kb: Record<string, unknown>,
  options?: KbBootstrapOptions,
): Promise<DatasourceProfile | undefined> {
  // Keep every KB-backed datasource materialization path on this helper so init/doctor/query/resolve
  // all persist the same canonical routing shape instead of drifting through ad-hoc saves.
  const candidate = buildKbBootstrapCandidate(env, service, datasourceName, kb, options);
  if (!candidate) return undefined;
  for (const spec of candidate.credentialDefaults) await ensureCredentialDefaults(ctx, spec.ref, spec.defaults, spec.overwrite);
  return ctx.datasourceStore.save(candidate.profile);
}

export async function reconcileDatasource(
  ctx: AppContext,
  env: string,
  service: string,
  namespace?: string,
): Promise<BootstrapResult | undefined> {
  const kb = ctx.kbStore.resolveConnection(service, env, namespace);
  if (!kb) return undefined;

  const resolvedName = defaultDatasourceName(env, service, str(kb.namespace || namespace).trim() || undefined);
  if (!buildKbBootstrapCandidate(env, service, resolvedName, kb)) return undefined;

  const existing = ctx.datasourceStore.resolveByEnvService(env, service, namespace);
  const critical = existing ? criticalDatasourceKbConflicts(existing, kb) : [];
  if (existing && !critical.length) return { profile: existing, source: 'store-existing', ...collectBootstrapMetadata(existing) };

  const profile = await saveKbBootstrapCandidate(ctx, env, service, resolvedName, kb);
  if (!profile) return undefined;
  return { profile, source: existing ? 'kb-repaired' : 'kb-bootstrap', ...collectBootstrapMetadata(profile) };
}
