import type { AppContext } from './app.js';
import { defaultDatasourceName } from './app.js';
import { criticalDatasourceKbConflicts } from './conflicts.js';
import { nowIso } from './time.js';
import { AccessMethod, DatasourceKind } from '../types/core.js';
import type { DatasourceProfile } from '../types/core.js';

export interface BootstrapResult {
  profile: DatasourceProfile;
  source: 'store-existing' | 'kb-bootstrap' | 'kb-repaired';
  credentialRefs: string[];
  connectors: string[];
  warnings: string[];
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
  confidence?: number;
}

function collectBootstrapMetadata(profile: DatasourceProfile): Pick<BootstrapResult, 'credentialRefs' | 'connectors' | 'warnings'> {
  const refs = new Set<string>();
  if (profile.credentialRef) refs.add(profile.credentialRef);
  for (const value of Object.values(profile.resolverHints || {})) {
    const ref = String(value || '').trim();
    if (ref) refs.add(ref);
  }
  return {
    credentialRefs: [...refs],
    connectors: profile.connectors || [],
    warnings: [],
  };
}

export async function ensureCredentialDefaults(
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
  engine: string;
  database: string;
  dbUser: string;
  target: string;
  credentialRef: string;
  tags: string[];
  confidence: number;
  namespace?: string;
}

interface BootstrapStrategy {
  accessMethod: string;
  build(c: BootstrapContext): KbBootstrapCandidate | undefined;
}

const VPN_STATUS_COMMAND = 'pgrep -f openvpn >/dev/null && echo connected || (echo disconnected >&2; exit 1)';
const VPN_CREDENTIAL_DEFAULT: CredentialDefaultSpec = {
  ref: 'vpn:work',
  defaults: { statusCommand: VPN_STATUS_COMMAND },
};

function sqlKindFromEngine(engine: string): string {
  return engine.includes('postgres') ? DatasourceKind.Postgres : DatasourceKind.Mysql;
}

function buildQaPortforwardCandidate(c: BootstrapContext): KbBootstrapCandidate {
  const effectiveNamespace = String(c.namespace || 'default');
  const context = String(process.env.TAPROOT_QA_CONTEXT || c.kb.k8s_context || c.env || effectiveNamespace);
  const localPort = Number(process.env.TAPROOT_QA_LOCAL_PORT || 4406);
  const logFile = `/tmp/taproot-pf-${c.env}-${c.service}.log`;
  const statusCommand = `lsof -iTCP:${localPort} -sTCP:LISTEN >/dev/null`;
  const connectCommand = `${statusCommand} || (svc_port=$(kubectl --context ${context} -n ${effectiveNamespace} get svc/${c.target} -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || echo 4000); nohup kubectl --context ${context} -n ${effectiveNamespace} port-forward svc/${c.target} ${localPort}:$svc_port >${logFile} 2>&1 & for _ in 1 2 3 4 5; do ${statusCommand} && break; sleep 1; done; ${statusCommand})`;
  const kpfRef = `kpf:${c.env}:${c.namespace || 'default'}:${c.service}`;
  return {
    kb: c.kb,
    profile: {
      name: c.datasourceName,
      kind: sqlKindFromEngine(c.engine),
      env: c.env,
      namespace: c.namespace,
      service: c.service,
      tags: c.tags,
      connection: { host: '127.0.0.1', port: localPort, database: c.database },
      credentialRef: c.credentialRef,
      connectors: ['openvpn', 'kubectl-portforward'],
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      resolverHints: {
        openvpnCredentialRef: 'vpn:work',
        'kubectl-portforwardCredentialRef': kpfRef,
      },
      updatedAt: nowIso(),
      confidence: c.confidence,
    },
    credentialDefaults: [
      { ref: c.credentialRef, defaults: { user: c.dbUser || 'root' } },
      VPN_CREDENTIAL_DEFAULT,
      { ref: kpfRef, defaults: { statusCommand, connectCommand }, overwrite: true },
    ],
  };
}

function buildNativeCandidate(c: BootstrapContext): KbBootstrapCandidate | undefined {
  const host = String(c.kb.host || '').trim();
  if (!host) return undefined;
  const port = Number(c.kb.port || 0) || (c.engine.includes('postgres') ? 5432 : 3306);
  return {
    kb: c.kb,
    profile: {
      name: c.datasourceName,
      kind: sqlKindFromEngine(c.engine),
      env: c.env,
      namespace: c.namespace,
      service: c.service,
      tags: c.tags,
      connection: { host, port, database: c.database },
      credentialRef: c.credentialRef,
      connectors: ['openvpn'],
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      resolverHints: { openvpnCredentialRef: 'vpn:work' },
      updatedAt: nowIso(),
      confidence: c.confidence,
    },
    credentialDefaults: [
      { ref: c.credentialRef, defaults: { user: c.dbUser || 'root' } },
      VPN_CREDENTIAL_DEFAULT,
    ],
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
      connectors: ['openvpn', 'teleport'],
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      resolverHints: {
        openvpnCredentialRef: 'vpn:work',
        teleportCredentialRef: tshRef,
      },
      updatedAt: nowIso(),
      confidence: c.confidence,
    },
    credentialDefaults: [
      { ref: c.credentialRef, defaults: { dbUser: c.dbUser } },
      VPN_CREDENTIAL_DEFAULT,
      { ref: tshRef, defaults: { statusCommand: 'tsh status' } },
    ],
  };
}

const BOOTSTRAP_STRATEGIES: BootstrapStrategy[] = [
  { accessMethod: AccessMethod.QaPortforward, build: buildQaPortforwardCandidate },
  { accessMethod: AccessMethod.Native, build: buildNativeCandidate },
  { accessMethod: AccessMethod.Tsh, build: buildTshCandidate },
];

export function buildKbBootstrapCandidate(
  env: string,
  service: string,
  datasourceName: string,
  kb: Record<string, unknown>,
  options?: KbBootstrapOptions,
): KbBootstrapCandidate | undefined {
  const accessMethod = String(kb.access_method || '').toLowerCase();
  const strategy = BOOTSTRAP_STRATEGIES.find((s) => s.accessMethod === accessMethod);
  if (!strategy) return undefined;
  const c: BootstrapContext = {
    env,
    service,
    datasourceName,
    kb,
    engine: String(kb.engine || 'mysql').toLowerCase(),
    database: String(kb.database || ''),
    dbUser: String(kb.db_user || ''),
    target: String(options?.targetOverride || kb.target || ''),
    credentialRef: env,
    tags: options?.tags || ['auto-bootstrap', 'kb-derived'],
    confidence: options?.confidence ?? 0.9,
    namespace: String(kb.namespace || '').trim() || undefined,
  };
  return strategy.build(c);
}

async function applyCredentialDefaults(ctx: AppContext, specs: CredentialDefaultSpec[]): Promise<void> {
  for (const spec of specs) {
    await ensureCredentialDefaults(ctx, spec.ref, spec.defaults, spec.overwrite);
  }
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
  await applyCredentialDefaults(ctx, candidate.credentialDefaults);
  return ctx.datasourceStore.save(candidate.profile);
}

export async function bootstrapDatasource(
  ctx: AppContext,
  env: string,
  service: string,
  datasourceName: string,
  namespace?: string,
): Promise<BootstrapResult | undefined> {
  const existing = ctx.datasourceStore.resolveByEnvService(env, service, namespace);
  if (existing) {
    return {
      profile: existing,
      source: 'store-existing',
      ...collectBootstrapMetadata(existing),
    };
  }

  const kb = ctx.kbStore.resolveConnection(service, env, namespace);
  if (!kb) return undefined;
  const resolvedName = defaultDatasourceName(env, service, String(kb.namespace || namespace || '').trim() || undefined);
  const profile = await saveKbBootstrapCandidate(ctx, env, service, resolvedName, kb);
  if (!profile) return undefined;
  return {
    profile,
    source: 'kb-bootstrap',
    ...collectBootstrapMetadata(profile),
  };
}

export async function reconcileDatasource(
  ctx: AppContext,
  env: string,
  service: string,
  datasourceName: string,
  namespace?: string,
): Promise<BootstrapResult | undefined> {
  const kb = ctx.kbStore.resolveConnection(service, env, namespace);
  if (!kb) return undefined;

  const resolvedName = defaultDatasourceName(env, service, String(kb.namespace || namespace || '').trim() || undefined);
  const candidate = buildKbBootstrapCandidate(env, service, resolvedName, kb);
  if (!candidate) return undefined;

  const existing = ctx.datasourceStore.resolveByEnvService(env, service, namespace);
  if (!existing) {
    const profile = await saveKbBootstrapCandidate(ctx, env, service, resolvedName, kb);
    if (!profile) return undefined;
    return {
      profile,
      source: 'kb-bootstrap',
      ...collectBootstrapMetadata(profile),
    };
  }

  const critical = criticalDatasourceKbConflicts(existing, kb);
  if (!critical.length) {
    return {
      profile: existing,
      source: 'store-existing',
      ...collectBootstrapMetadata(existing),
    };
  }

  const profile = await saveKbBootstrapCandidate(ctx, env, service, resolvedName, kb);
  if (!profile) return undefined;
  return {
    profile,
    source: 'kb-repaired',
    ...collectBootstrapMetadata(profile),
  };
}
