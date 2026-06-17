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

export function buildKbBootstrapCandidate(
  env: string,
  service: string,
  datasourceName: string,
  kb: Record<string, unknown>,
  options?: KbBootstrapOptions,
): KbBootstrapCandidate | undefined {
  const accessMethod = String(kb.access_method || '').toLowerCase();
  const engine = String(kb.engine || 'mysql').toLowerCase();
  const database = String(kb.database || '');
  const dbUser = String(kb.db_user || '');
  const target = String(options?.targetOverride || kb.target || '');
  const credentialRef = env;
  const tags = options?.tags || ['auto-bootstrap', 'kb-derived'];
  const confidence = options?.confidence ?? 0.9;
  const namespace = String(kb.namespace || '').trim() || undefined;

  if (accessMethod === AccessMethod.QaPortforward) {
    const effectiveNamespace = String(namespace || 'default');
    const context = String(process.env.TAPROOT_QA_CONTEXT || kb.k8s_context || env || effectiveNamespace);
    const localPort = Number(process.env.TAPROOT_QA_LOCAL_PORT || 4406);
    const logFile = `/tmp/taproot-pf-${env}-${service}.log`;
    const statusCommand = `lsof -iTCP:${localPort} -sTCP:LISTEN >/dev/null`;
    const connectCommand = `${statusCommand} || (svc_port=$(kubectl --context ${context} -n ${effectiveNamespace} get svc/${target} -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || echo 4000); nohup kubectl --context ${context} -n ${effectiveNamespace} port-forward svc/${target} ${localPort}:$svc_port >${logFile} 2>&1 & for _ in 1 2 3 4 5; do ${statusCommand} && break; sleep 1; done; ${statusCommand})`;

    return {
      kb,
      profile: {
        name: datasourceName,
        kind: engine.includes('postgres') ? DatasourceKind.Postgres : DatasourceKind.Mysql,
        env,
        namespace,
        service,
        tags,
        connection: {
          host: '127.0.0.1',
          port: localPort,
          database,
        },
        credentialRef,
        connectors: ['openvpn', 'kubectl-portforward'],
        policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
        resolverHints: {
          openvpnCredentialRef: 'vpn:work',
          'kubectl-portforwardCredentialRef': `kpf:${env}:${namespace || 'default'}:${service}`,
        },
        updatedAt: nowIso(),
        confidence,
      },
      credentialDefaults: [
        {
          ref: credentialRef,
          defaults: {
            user: dbUser || 'root',
          },
        },
        {
          ref: 'vpn:work',
          defaults: {
            statusCommand: 'pgrep -f openvpn >/dev/null && echo connected || (echo disconnected >&2; exit 1)',
          },
        },
        {
          ref: `kpf:${env}:${namespace || 'default'}:${service}`,
          defaults: {
            statusCommand,
            connectCommand,
          },
          overwrite: true,
        },
      ],
    };
  }

  if (accessMethod === AccessMethod.Native) {
    const host = String(kb.host || '').trim();
    const port = Number(kb.port || 0) || (engine.includes('postgres') ? 5432 : 3306);
    if (!host) return undefined;
    return {
      kb,
      profile: {
        name: datasourceName,
        kind: engine.includes('postgres') ? DatasourceKind.Postgres : DatasourceKind.Mysql,
        env,
        namespace,
        service,
        tags,
        connection: {
          host,
          port,
          database,
        },
        credentialRef,
        connectors: ['openvpn'],
        policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
        resolverHints: {
          openvpnCredentialRef: 'vpn:work',
        },
        updatedAt: nowIso(),
        confidence,
      },
      credentialDefaults: [
        {
          ref: credentialRef,
          defaults: {
            user: dbUser || 'root',
          },
        },
        {
          ref: 'vpn:work',
          defaults: {
            statusCommand: 'pgrep -f openvpn >/dev/null && echo connected || (echo disconnected >&2; exit 1)',
          },
        },
      ],
    };
  }

  if (accessMethod === AccessMethod.Tsh) {
    return {
      kb,
      profile: {
        name: datasourceName,
        kind: DatasourceKind.TeleportMysql,
        env,
        namespace,
        service,
        tags,
        connection: {
          database,
          target,
        },
        credentialRef,
        connectors: ['openvpn', 'teleport'],
        policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
        resolverHints: {
          openvpnCredentialRef: 'vpn:work',
          teleportCredentialRef: `tsh:${env}`,
        },
        updatedAt: nowIso(),
        confidence,
      },
      credentialDefaults: [
        {
          ref: credentialRef,
          defaults: {
            dbUser,
          },
        },
        {
          ref: 'vpn:work',
          defaults: {
            statusCommand: 'pgrep -f openvpn >/dev/null && echo connected || (echo disconnected >&2; exit 1)',
          },
        },
        {
          ref: `tsh:${env}`,
          defaults: {
            statusCommand: 'tsh status',
          },
        },
      ],
    };
  }

  return undefined;
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
