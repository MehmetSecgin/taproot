import type { AppContext } from './app.js';
import { nowIso } from './time.js';
import type { DatasourceProfile } from '../types/core.js';

export interface BootstrapResult {
  profile: DatasourceProfile;
  source: 'store-existing' | 'kb-bootstrap';
  credentialRefs: string[];
  connectors: string[];
  warnings: string[];
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

export async function bootstrapDatasource(
  ctx: AppContext,
  env: string,
  service: string,
  datasourceName: string,
): Promise<BootstrapResult | undefined> {
  const existing = ctx.datasourceStore.get(datasourceName);
  if (existing) {
    return {
      profile: existing,
      source: 'store-existing',
      ...collectBootstrapMetadata(existing),
    };
  }

  const kb = ctx.kbStore.resolveConnection(service, env);
  if (!kb) return undefined;
  const accessMethod = String(kb.access_method || '').toLowerCase();
  const engine = String(kb.engine || 'mysql').toLowerCase();
  const database = String(kb.database || '');
  const dbUser = String(kb.db_user || '');
  const target = String(kb.target || '');
  const credentialRef = `${env}:${service}`;

  if (accessMethod === 'qa-portforward') {
    const namespace = String(kb.namespace || 'develop');
    const context = String(process.env.TAPROOT_QA_CONTEXT || kb.k8s_context || env || namespace);
    const localPort = Number(process.env.TAPROOT_QA_LOCAL_PORT || 4406);
    const logFile = `/tmp/taproot-pf-${env}-${service}.log`;
    const statusCommand = `lsof -iTCP:${localPort} -sTCP:LISTEN >/dev/null`;
    const connectCommand = `${statusCommand} || (svc_port=$(kubectl --context ${context} -n ${namespace} get svc/${target} -o jsonpath='{.spec.ports[0].port}' 2>/dev/null || echo 4000); nohup kubectl --context ${context} -n ${namespace} port-forward svc/${target} ${localPort}:$svc_port >${logFile} 2>&1 & for _ in 1 2 3 4 5; do ${statusCommand} && break; sleep 1; done; ${statusCommand})`;

    await ensureCredentialDefaults(ctx, credentialRef, {
      user: dbUser || 'root',
    });
    await ensureCredentialDefaults(ctx, 'vpn:work', {
      statusCommand: 'pgrep -f openvpn >/dev/null && echo connected || (echo disconnected >&2; exit 1)',
    });
    await ensureCredentialDefaults(
      ctx,
      `kpf:${env}:${service}`,
      {
        statusCommand,
        connectCommand,
      },
      true,
    );

    const profile = ctx.datasourceStore.save({
      name: datasourceName,
      kind: engine.includes('postgres') ? 'postgres' : 'mysql',
      env,
      service,
      tags: ['auto-bootstrap', 'kb-derived'],
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
        'kubectl-portforwardCredentialRef': `kpf:${env}:${service}`,
      },
      updatedAt: nowIso(),
      confidence: 0.9,
    } as DatasourceProfile);
    return {
      profile,
      source: 'kb-bootstrap',
      ...collectBootstrapMetadata(profile),
    };
  }

  if (accessMethod === 'tsh') {
    await ensureCredentialDefaults(ctx, credentialRef, {
      dbUser,
    });
    await ensureCredentialDefaults(ctx, 'vpn:work', {
      statusCommand: 'pgrep -f openvpn >/dev/null && echo connected || (echo disconnected >&2; exit 1)',
    });
    await ensureCredentialDefaults(ctx, `tsh:${env}`, {
      statusCommand: 'tsh status',
    });
    const profile = ctx.datasourceStore.save({
      name: datasourceName,
      kind: 'teleport-mysql',
      env,
      service,
      tags: ['auto-bootstrap', 'kb-derived'],
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
      confidence: 0.9,
    } as DatasourceProfile);
    return {
      profile,
      source: 'kb-bootstrap',
      ...collectBootstrapMetadata(profile),
    };
  }

  return undefined;
}
