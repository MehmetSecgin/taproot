import net from 'node:net';
import tls from 'node:tls';
import type { ISocketFactory } from 'kafkajs';
import { DoctorStatus } from '../../types/core.js';
import type { DoctorCheck, QueryRequest, QueryResult, TapRootPlugin } from '../../types/core.js';
import { badInput, classifyExecutorDoctorCode } from '../../core/error-classification.js';
import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { nowIso } from '../../core/time.js';
import { str } from '../../core/strings.js';
import { parseKeyValuePairs } from '../../core/key-value.js';

export interface KafkaAdmin {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  listTopics(): Promise<string[]>;
  fetchTopicMetadata(options: { topics: string[] }): Promise<{ topics: Array<{ name: string; partitions: Array<{ partitionId: number; leader: number; replicas: number[]; isr: number[] }> }> }>;
  fetchTopicOffsets(topic: string): Promise<Array<{ partition: number; high: string; low: string }>>;
  listGroups(): Promise<{ groups: Array<{ groupId: string; protocolType: string }> }>;
  describeGroups(groupIds: string[]): Promise<{ groups: Array<{ groupId: string; state: string; protocol: string }> }>;
  fetchOffsets(options: { groupId: string; topics?: string[] }): Promise<Array<{ topic: string; partitions: Array<{ partition: number; offset: string }> }>>;
}

export type KafkaAdminFactory = (ds: QueryRequest['datasource'], creds: Record<string, string>) => Promise<KafkaAdmin>;

const HOST_PORT = /^[^\s:=,]+:\d{1,5}$/;

export function parseBrokerMap(hint: string | undefined): Map<string, string> {
  const raw = str(hint).trim();
  if (!raw) return new Map();
  const pairs = parseKeyValuePairs('brokerMap hint', raw.split(',').map((p) => p.trim()));
  for (const [from, to] of Object.entries(pairs)) {
    if (!HOST_PORT.test(from) || !HOST_PORT.test(to)) {
      throw badInput(`Invalid brokerMap hint entry '${from}=${to}'. Expected <advertised host:port>=<local host:port>[,...].`);
    }
  }
  return new Map(Object.entries(pairs));
}

export function brokerSocketFactory(map: Map<string, string>): ISocketFactory {
  return ({ host, port, ssl, onConnect }) => {
    const target = map.get(`${host}:${port}`);
    const split = target ? target.lastIndexOf(':') : -1;
    const toHost = target ? target.slice(0, split) : host;
    const toPort = target ? Number(target.slice(split + 1)) : port;
    const socket = ssl
      ? tls.connect({ ...ssl, host: toHost, port: toPort, servername: host }, onConnect)
      : net.connect({ host: toHost, port: toPort }, onConnect);
    socket.setKeepAlive(true, 60000);
    return socket;
  };
}

async function kafkajsAdmin(ds: QueryRequest['datasource'], creds: Record<string, string>): Promise<KafkaAdmin> {
  const brokerMap = parseBrokerMap(ds.resolverHints?.brokerMap);
  let kafkajs: typeof import('kafkajs');
  try {
    kafkajs = await import('kafkajs');
  } catch {
    throw new Error("kafka plugin needs the optional 'kafkajs' dependency; reinstall TapRoot with optional dependencies.");
  }
  const host = str(ds.connection.host || '127.0.0.1');
  const port = Number(ds.connection.port || 9092);
  const sasl = creds.user && creds.password
    ? { mechanism: 'plain' as const, username: String(creds.user), password: String(creds.password) }
    : undefined;
  const kafka = new kafkajs.Kafka({
    clientId: 'taproot',
    brokers: [`${host}:${port}`],
    ssl: Boolean(ds.connection.ssl),
    ...(sasl ? { sasl } : {}),
    ...(brokerMap.size ? { socketFactory: brokerSocketFactory(brokerMap) } : {}),
    connectionTimeout: RUNTIME_CONSTANTS.plugin.dbConnectTimeoutMs,
    logLevel: kafkajs.logLevel.NOTHING,
  });
  return kafka.admin({ retry: { retries: 1 } }) as unknown as KafkaAdmin;
}

let adminFactory: KafkaAdminFactory = kafkajsAdmin;

export function setKafkaAdminFactory(factory: KafkaAdminFactory | undefined): void {
  adminFactory = factory || kafkajsAdmin;
}

function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`);
}

function matchFilter(tokens: string[], verb: string): RegExp | undefined {
  if (tokens.length === 1) return undefined;
  if (tokens.length === 3 && tokens[1]?.toUpperCase() === 'MATCH') return globToRegExp(String(tokens[2]));
  throw badInput(`kafka ${verb} takes no arguments or MATCH <glob>.`);
}

interface Table { columns: string[]; rows: unknown[][] }

async function topics(admin: KafkaAdmin, tokens: string[]): Promise<Table> {
  const match = matchFilter(tokens, 'topics');
  const names = (await admin.listTopics()).filter((t) => !match || match.test(t));
  const meta = names.length ? (await admin.fetchTopicMetadata({ topics: names })).topics : [];
  const rows = meta
    .map((t) => [t.name, t.partitions.length, t.partitions[0]?.replicas.length ?? 0])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return { columns: ['topic', 'partitions', 'replicationFactor'], rows };
}

async function describe(admin: KafkaAdmin, tokens: string[]): Promise<Table> {
  if (tokens.length !== 2) throw badInput('kafka describe takes exactly one topic: describe <topic>.');
  const topic = String(tokens[1]);
  const [meta, offsets] = await Promise.all([admin.fetchTopicMetadata({ topics: [topic] }), admin.fetchTopicOffsets(topic)]);
  const byPartition = new Map(offsets.map((o) => [o.partition, o]));
  const partitions = meta.topics[0]?.partitions || [];
  const rows = [...partitions]
    .sort((a, b) => a.partitionId - b.partitionId)
    .map((p) => [p.partitionId, p.leader, p.replicas.join(','), p.isr.join(','), byPartition.get(p.partitionId)?.low ?? null, byPartition.get(p.partitionId)?.high ?? null]);
  return { columns: ['partition', 'leader', 'replicas', 'isr', 'logStart', 'logEnd'], rows };
}

async function groups(admin: KafkaAdmin, tokens: string[]): Promise<Table> {
  const match = matchFilter(tokens, 'groups');
  const ids = (await admin.listGroups()).groups.map((g) => g.groupId).filter((g) => !match || match.test(g));
  const described = ids.length ? (await admin.describeGroups(ids)).groups : [];
  const rows = described.map((g) => [g.groupId, g.state, g.protocol]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return { columns: ['group', 'state', 'protocol'], rows };
}

interface LagRow { cells: unknown[]; committed: boolean }

async function groupLagRows(admin: KafkaAdmin, groupId: string, topic: string | undefined, ends: Map<string, Map<number, string>>): Promise<LagRow[]> {
  const committed = await admin.fetchOffsets({ groupId, ...(topic ? { topics: [topic] } : {}) });
  const rows: LagRow[] = [];
  for (const t of committed) {
    if (!ends.has(t.topic)) {
      const offsets = await admin.fetchTopicOffsets(t.topic);
      ends.set(t.topic, new Map(offsets.map((o) => [o.partition, o.high])));
    }
    const topicEnds = ends.get(t.topic) as Map<number, string>;
    for (const p of [...t.partitions].sort((a, b) => a.partition - b.partition)) {
      const logEnd = topicEnds.get(p.partition);
      const hasCommit = Number(p.offset) >= 0;
      const lag = hasCommit && logEnd !== undefined ? Number(logEnd) - Number(p.offset) : null;
      rows.push({ cells: [groupId, t.topic, p.partition, hasCommit ? p.offset : null, logEnd ?? null, lag, !hasCommit], committed: hasCommit });
    }
  }
  return rows;
}

async function lag(admin: KafkaAdmin, tokens: string[]): Promise<Table> {
  const selector = tokens[1]?.toUpperCase();
  if (tokens.length !== 3 || (selector !== 'GROUP' && selector !== 'TOPIC')) {
    throw badInput('kafka lag needs exactly one selector: lag GROUP <id> or lag TOPIC <name>.');
  }
  const value = String(tokens[2]);
  const columns = ['group', 'topic', 'partition', 'committed', 'logEnd', 'lag', 'noCommit'];
  const ends = new Map<string, Map<number, string>>();
  if (selector === 'GROUP') return { columns, rows: (await groupLagRows(admin, value, undefined, ends)).map((r) => r.cells) };
  const ids = (await admin.listGroups()).groups.map((g) => g.groupId).sort();
  const rows: unknown[][] = [];
  for (const id of ids) {
    const groupRows = await groupLagRows(admin, id, value, ends);
    if (groupRows.some((r) => r.committed)) rows.push(...groupRows.map((r) => r.cells));
  }
  return { columns, rows };
}

const VERBS: Record<string, (admin: KafkaAdmin, tokens: string[]) => Promise<Table>> = {
  TOPICS: topics,
  DESCRIBE: describe,
  GROUPS: groups,
  LAG: lag,
};

async function withAdmin<T>(ds: QueryRequest['datasource'], creds: Record<string, string>, run: (admin: KafkaAdmin) => Promise<T>): Promise<T> {
  const admin = await adminFactory(ds, creds);
  await admin.connect();
  try {
    return await run(admin);
  } finally {
    await admin.disconnect().catch(() => undefined);
  }
}

export const kafkaPlugin: TapRootPlugin = {
  manifest: {
    name: 'kafka',
    capabilities: ['doctor', 'executeRead'],
  },

  async doctor(input): Promise<DoctorCheck[]> {
    try {
      const count = await withAdmin(input.datasource, input.credentials, async (admin) => (await admin.listTopics()).length);
      return [{ check: 'kafka metadata', status: DoctorStatus.Ok, detail: `broker answered; ${count} topic(s)` }];
    } catch (error) {
      const detail = ((error as Error).message || String(error)).slice(0, 400);
      return [{ check: 'kafka metadata', status: DoctorStatus.Fail, detail, code: classifyExecutorDoctorCode(detail) }];
    }
  },

  async execute(request, creds): Promise<QueryResult> {
    const startedAt = nowIso();
    const start = Date.now();
    const tokens = request.query.trim().split(/\s+/).filter(Boolean);
    const verb = str(tokens[0]).toUpperCase();
    const run = VERBS[verb];
    if (!run) throw badInput(`kafka verb '${verb || '(none)'}' not supported; use topics, describe, groups or lag.`);
    const table = await withAdmin(request.datasource, creds, (admin) => run(admin, tokens));
    return {
      datasource: request.datasource.name,
      plugin: 'kafka',
      capability: request.capability,
      query: { native: request.query },
      result: { columns: table.columns, rows: table.rows },
      timings: { startedAt, endedAt: nowIso(), durationMs: Date.now() - start },
      warnings: [],
      classification: 'success',
    };
  },
};
