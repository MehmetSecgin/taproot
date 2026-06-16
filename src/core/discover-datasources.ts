import { spawnSync } from 'node:child_process';
import { defaultDatasourceName, normalizeService } from './app.js';
import { buildKbBootstrapCandidate, ensureCredentialDefaults } from './bootstrap.js';
import { nowIso } from './time.js';
import type { AppContext } from './app.js';
import type { DatasourceProfile } from '../types/core.js';

export type DiscoverySource = 'kubectl' | 'teleport' | 'kb';
export type DiscoveryMode = 'native' | 'qa-portforward' | 'tsh';

export interface KubeServicePort {
  name?: string;
  port?: number;
  protocol?: string;
  targetPort?: number | string;
}

export interface KubeService {
  metadata?: { name?: string; namespace?: string; labels?: Record<string, string> };
  spec?: { ports?: KubeServicePort[]; selector?: Record<string, string>; type?: string; clusterIP?: string };
}

export interface KubeServiceListing {
  items?: KubeService[];
}

export interface TshDatabase {
  kind?: string;
  metadata?: { name?: string; description?: string; labels?: Record<string, string> };
  spec?: { protocol?: string; uri?: string };
  // Some `tsh db ls --format=json` shapes flatten this; tolerate both.
  name?: string;
  protocol?: string;
  labels?: Record<string, string>;
  uri?: string;
}

export interface DiscoveryProposal {
  name: string;
  kind: 'mysql' | 'postgres' | 'teleport-mysql';
  env: string;
  service: string;
  namespace?: string;
  connection: { host?: string; port?: number; database?: string; target?: string };
  credentialRef: string;
  connectors: string[];
  resolverHints: Record<string, string>;
  source: DiscoverySource;
  confidence: number;
  reason: string;
}

const DB_SERVICE_PATTERNS: Array<{ pattern: RegExp; engine: 'mysql' | 'postgres' }> = [
  { pattern: /(mysql|mariadb|maria|tidb|percona|aurora)/i, engine: 'mysql' },
  { pattern: /(postgres|postgresql|pgbouncer|^pg-)/i, engine: 'postgres' },
];

const DB_PORT_MAP: Record<number, 'mysql' | 'postgres'> = {
  3306: 'mysql',
  4000: 'mysql', // tidb
  6000: 'mysql', // tiproxy (mysql wire)
  6033: 'mysql', // alternate mysql proxy port
  5432: 'postgres',
  6432: 'postgres', // pgbouncer
};

const SYSTEM_NAMESPACES = new Set([
  'kube-system',
  'kube-public',
  'kube-node-lease',
  'ingress-nginx',
  'cert-manager',
  'monitoring',
  'logging',
  'istio-system',
]);

function inferDatabaseName(service: string): string {
  return service.replace(/-/g, '_');
}

export interface KubeClassifyOptions {
  env: string;
  aliases?: Record<string, string>;
  vpn?: boolean;
  hostPattern?: 'service-name' | 'tiproxy';
  sharedCredentialRef?: boolean;
}

export function classifyKubeService(svc: KubeService, opts: KubeClassifyOptions): DiscoveryProposal | null {
  const name = svc.metadata?.name?.trim();
  if (!name) return null;
  const namespace = svc.metadata?.namespace?.trim() || undefined;
  if (namespace && SYSTEM_NAMESPACES.has(namespace)) return null;

  const ports = (svc.spec?.ports || []).filter((p) => typeof p.port === 'number');
  let engine: 'mysql' | 'postgres' | null = null;
  let matchedPort: number | undefined;
  let reason = '';

  for (const p of ports) {
    const detected = DB_PORT_MAP[p.port as number];
    if (detected) {
      engine = detected;
      matchedPort = p.port as number;
      reason = `port ${p.port}`;
      break;
    }
  }

  if (!engine) {
    for (const { pattern, engine: e } of DB_SERVICE_PATTERNS) {
      if (pattern.test(name)) {
        engine = e;
        reason = `service name matches /${pattern.source}/`;
        matchedPort = ports[0]?.port;
        break;
      }
    }
  }

  if (!engine) return null;
  const port = matchedPort ?? (engine === 'postgres' ? 5432 : 3306);

  const service = normalizeService(name, opts.aliases || {});
  const profileName = defaultDatasourceName(opts.env, service, namespace);
  const credentialRef = opts.sharedCredentialRef ? opts.env : `${opts.env}:${service}`;
  const vpn = opts.vpn !== false;
  const host = opts.hostPattern === 'tiproxy'
    ? `tiproxy-${service}.${namespace || 'default'}`
    : name;

  return {
    name: profileName,
    kind: engine,
    env: opts.env,
    service,
    namespace,
    connection: { host, port, database: inferDatabaseName(service) },
    credentialRef,
    connectors: vpn ? ['openvpn'] : [],
    resolverHints: vpn ? { openvpnCredentialRef: 'vpn:work' } : {},
    source: 'kubectl',
    confidence: 0.65,
    reason: `${reason}; host=${host}:${port}${vpn ? '; openvpn wired' : ''}`,
  };
}

function tshDbName(db: TshDatabase): string {
  return (db.metadata?.name || db.name || '').trim();
}

function tshDbProtocol(db: TshDatabase): string {
  return String(db.spec?.protocol || db.protocol || '').trim().toLowerCase();
}

function tshDbLabels(db: TshDatabase): Record<string, string> {
  return db.metadata?.labels || db.labels || {};
}

export interface TshClassifyOptions {
  env: string;
  aliases?: Record<string, string>;
  vpn?: boolean;
}

export function classifyTshDatabase(db: TshDatabase, opts: TshClassifyOptions): DiscoveryProposal | null {
  const name = tshDbName(db);
  if (!name) return null;
  const protocol = tshDbProtocol(db);
  const labels = tshDbLabels(db);
  const labelEnv = (labels.env || labels.environment || '').toLowerCase();
  if (labelEnv && labelEnv !== opts.env.toLowerCase()) return null;

  let engine: 'mysql' | 'postgres' | null = null;
  if (protocol === 'mysql' || protocol === 'mariadb' || protocol === 'tidb') engine = 'mysql';
  else if (protocol === 'postgres' || protocol === 'postgresql') engine = 'postgres';
  if (!engine) return null;

  const serviceRaw = labels.service || labels.app || name;
  const service = normalizeService(serviceRaw, opts.aliases || {});
  const profileName = defaultDatasourceName(opts.env, service);
  const credentialRef = `${opts.env}:${service}`;
  const kind: DiscoveryProposal['kind'] = engine === 'mysql' ? 'teleport-mysql' : 'postgres';
  const vpn = opts.vpn !== false;

  const connectors = vpn ? ['openvpn', 'teleport'] : ['teleport'];
  const resolverHints: Record<string, string> = { teleportCredentialRef: `tsh:${opts.env}` };
  if (vpn) resolverHints.openvpnCredentialRef = 'vpn:work';

  return {
    name: profileName,
    kind,
    env: opts.env,
    service,
    connection: { database: inferDatabaseName(service), target: name },
    credentialRef,
    connectors,
    resolverHints,
    source: 'teleport',
    confidence: 0.75,
    reason: `tsh db '${name}' protocol=${protocol}${labelEnv ? ` env-label=${labelEnv}` : ''}${vpn ? '; openvpn wired' : ''}`,
  };
}

export interface FetchKubeOptions {
  namespace?: string;
  kubectlPath?: string;
  context?: string;
}

export function fetchKubeServices(opts: FetchKubeOptions = {}): { ok: boolean; services: KubeService[]; detail: string } {
  const args = ['get', 'svc', '-o', 'json'];
  if (opts.namespace) args.unshift('-n', opts.namespace);
  else args.unshift('-A');
  if (opts.context) args.unshift('--context', opts.context);
  const proc = spawnSync(opts.kubectlPath || 'kubectl', args, { encoding: 'utf8' });
  if ((proc.status || 0) !== 0) {
    return { ok: false, services: [], detail: (proc.stderr || proc.stdout || `kubectl exit=${proc.status}`).trim() };
  }
  try {
    const parsed = JSON.parse(proc.stdout || '{}') as KubeServiceListing;
    return { ok: true, services: parsed.items || [], detail: `kubectl returned ${parsed.items?.length || 0} services` };
  } catch (err) {
    return { ok: false, services: [], detail: `failed to parse kubectl output: ${(err as Error).message}` };
  }
}

export function fetchTshDatabases(opts: { tshPath?: string } = {}): { ok: boolean; databases: TshDatabase[]; detail: string } {
  const proc = spawnSync(opts.tshPath || 'tsh', ['db', 'ls', '--format=json'], { encoding: 'utf8' });
  if ((proc.status || 0) !== 0) {
    return { ok: false, databases: [], detail: (proc.stderr || proc.stdout || `tsh exit=${proc.status}`).trim() };
  }
  try {
    const parsed = JSON.parse(proc.stdout || '[]') as TshDatabase[] | { items?: TshDatabase[] };
    const list = Array.isArray(parsed) ? parsed : parsed.items || [];
    return { ok: true, databases: list, detail: `tsh returned ${list.length} databases` };
  } catch (err) {
    return { ok: false, databases: [], detail: `failed to parse tsh output: ${(err as Error).message}` };
  }
}

export interface ApplyOptions {
  force?: boolean;
}

export interface ApplyResult {
  saved: DatasourceProfile[];
  skipped: Array<{ name: string; reason: string }>;
  conflicts: Array<{ name: string; existing: DatasourceProfile; proposed: DiscoveryProposal }>;
}

export function proposalToProfile(p: DiscoveryProposal): DatasourceProfile {
  return {
    name: p.name,
    kind: p.kind,
    env: p.env,
    namespace: p.namespace,
    service: p.service,
    tags: ['discovered', `source:${p.source}`],
    connection: p.connection,
    credentialRef: p.credentialRef,
    connectors: p.connectors,
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    resolverHints: p.resolverHints,
    updatedAt: nowIso(),
    confidence: p.confidence,
  } as DatasourceProfile;
}

export function applyProposals(ctx: AppContext, proposals: DiscoveryProposal[], opts: ApplyOptions = {}): ApplyResult {
  const result: ApplyResult = { saved: [], skipped: [], conflicts: [] };
  for (const proposal of proposals) {
    const existing = ctx.datasourceStore.get(proposal.name);
    if (existing && !opts.force) {
      result.conflicts.push({ name: proposal.name, existing, proposed: proposal });
      continue;
    }
    const saved = ctx.datasourceStore.save(proposalToProfile(proposal));
    result.saved.push(saved);
  }
  return result;
}

export interface KbDiscoverOptions {
  env: string;
  namespace?: string;
  service?: string;
}

interface KbServiceEntry {
  service?: string;
  connections?: Array<Record<string, unknown>>;
}

function kbConnectionToProposal(
  service: string,
  conn: Record<string, unknown>,
  env: string,
): DiscoveryProposal | null {
  const namespace = (String(conn.namespace || '').trim() || undefined);
  const datasourceName = defaultDatasourceName(env, service, namespace);
  const candidate = buildKbBootstrapCandidate(env, service, datasourceName, conn, { tags: ['discovered', 'source:kb', 'kb-derived'] });
  if (!candidate) return null;
  const p = candidate.profile;
  return {
    name: p.name,
    kind: p.kind as DiscoveryProposal['kind'],
    env: p.env || env,
    service: p.service || service,
    namespace: p.namespace,
    connection: p.connection || {},
    credentialRef: p.credentialRef,
    connectors: p.connectors || [],
    resolverHints: p.resolverHints || {},
    source: 'kb',
    confidence: p.confidence ?? 0.9,
    reason: `KB connection: access_method=${String(conn.access_method || '')} engine=${String(conn.engine || '')} target=${String(conn.target || '')}`.trim(),
  };
}

export function buildKbProposals(ctx: AppContext, opts: KbDiscoverOptions): { proposals: DiscoveryProposal[]; skipped: Array<{ service: string; reason: string }> } {
  const proposals: DiscoveryProposal[] = [];
  const skipped: Array<{ service: string; reason: string }> = [];
  const aliases = ctx.runtimeConfigStore.serviceAliases();
  const services = ctx.kbStore.services() as KbServiceEntry[];
  for (const entry of services) {
    const rawService = String(entry.service || '').trim();
    if (!rawService) continue;
    if (opts.service && rawService.toLowerCase() !== opts.service.toLowerCase()) continue;
    const service = normalizeService(rawService, aliases);
    const conns = Array.isArray(entry.connections) ? entry.connections : [];
    let matched = 0;
    for (const conn of conns) {
      if (String(conn.env || '').trim() !== opts.env) continue;
      if (String(conn.status || 'active').trim() !== 'active') continue;
      if (opts.namespace && String(conn.namespace || '').trim() !== opts.namespace) continue;
      const proposal = kbConnectionToProposal(service, conn, opts.env);
      if (proposal) {
        proposals.push(proposal);
        matched += 1;
      } else {
        skipped.push({ service: rawService, reason: `unsupported access_method=${String(conn.access_method || '')}` });
      }
    }
    if (!matched && !opts.service) continue;
  }
  return { proposals, skipped };
}

export interface KbApplyResult extends ApplyResult {
  credentialDefaultsApplied: number;
}

export async function applyKbProposals(
  ctx: AppContext,
  opts: KbDiscoverOptions & { force?: boolean },
): Promise<KbApplyResult> {
  const result: KbApplyResult = { saved: [], skipped: [], conflicts: [], credentialDefaultsApplied: 0 };
  const aliases = ctx.runtimeConfigStore.serviceAliases();
  const services = ctx.kbStore.services() as KbServiceEntry[];
  for (const entry of services) {
    const rawService = String(entry.service || '').trim();
    if (!rawService) continue;
    if (opts.service && rawService.toLowerCase() !== opts.service.toLowerCase()) continue;
    const service = normalizeService(rawService, aliases);
    const conns = Array.isArray(entry.connections) ? entry.connections : [];
    for (const conn of conns) {
      if (String(conn.env || '').trim() !== opts.env) continue;
      if (String(conn.status || 'active').trim() !== 'active') continue;
      if (opts.namespace && String(conn.namespace || '').trim() !== opts.namespace) continue;
      const namespace = (String(conn.namespace || '').trim() || undefined);
      const datasourceName = defaultDatasourceName(opts.env, service, namespace);
      const candidate = buildKbBootstrapCandidate(opts.env, service, datasourceName, conn, { tags: ['discovered', 'source:kb', 'kb-derived'] });
      if (!candidate) {
        result.skipped.push({ name: datasourceName, reason: `unsupported access_method=${String(conn.access_method || '')}` });
        continue;
      }
      const existing = ctx.datasourceStore.get(candidate.profile.name);
      if (existing && !opts.force) {
        result.conflicts.push({ name: candidate.profile.name, existing, proposed: kbConnectionToProposal(service, conn, opts.env)! });
        continue;
      }
      const saved = ctx.datasourceStore.save(candidate.profile);
      result.saved.push(saved);
      for (const credSpec of candidate.credentialDefaults) {
        await ensureCredentialDefaults(ctx, credSpec.ref, credSpec.defaults, credSpec.overwrite);
        result.credentialDefaultsApplied += 1;
      }
    }
  }
  return result;
}
