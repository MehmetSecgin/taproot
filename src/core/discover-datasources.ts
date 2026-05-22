import { spawnSync } from 'node:child_process';
import { defaultDatasourceName, normalizeService } from './app.js';
import { nowIso } from './time.js';
import type { AppContext } from './app.js';
import type { DatasourceProfile } from '../types/core.js';

export type DiscoverySource = 'kubectl' | 'teleport';
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
  4000: 'mysql', // tidb wire protocol
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

export function classifyKubeService(
  svc: KubeService,
  opts: { env: string; mode: DiscoveryMode; aliases?: Record<string, string> },
): DiscoveryProposal | null {
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
  const credentialRef = `${opts.env}:${service}`;

  if (opts.mode === 'qa-portforward') {
    return {
      name: profileName,
      kind: engine,
      env: opts.env,
      service,
      namespace,
      connection: { host: '127.0.0.1', port, database: inferDatabaseName(service), target: name },
      credentialRef,
      connectors: ['kubectl-portforward'],
      resolverHints: { 'kubectl-portforwardCredentialRef': `kpf:${opts.env}:${namespace || 'default'}:${service}` },
      source: 'kubectl',
      confidence: 0.7,
      reason: `${reason}; mode=qa-portforward via svc/${name} in ns ${namespace || 'default'}`,
    };
  }

  return {
    name: profileName,
    kind: engine,
    env: opts.env,
    service,
    namespace,
    connection: { host: name, port, database: inferDatabaseName(service) },
    credentialRef,
    connectors: [],
    resolverHints: {},
    source: 'kubectl',
    confidence: 0.6,
    reason: `${reason}; in-cluster DNS svc/${name}.${namespace || 'default'}`,
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

export function classifyTshDatabase(
  db: TshDatabase,
  opts: { env: string; aliases?: Record<string, string> },
): DiscoveryProposal | null {
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

  return {
    name: profileName,
    kind,
    env: opts.env,
    service,
    connection: { database: inferDatabaseName(service), target: name },
    credentialRef,
    connectors: kind === 'teleport-mysql' ? ['teleport'] : ['teleport'],
    resolverHints: { teleportCredentialRef: `tsh:${opts.env}` },
    source: 'teleport',
    confidence: 0.75,
    reason: `tsh db '${name}' protocol=${protocol}${labelEnv ? ` env-label=${labelEnv}` : ''}`,
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
