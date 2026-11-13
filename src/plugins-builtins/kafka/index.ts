import type { Admin } from '@platformatic/kafka';
import { DoctorStatus } from '../../types/core.js';
import type { DoctorCheck, QueryRequest, QueryResult, TapRootPlugin } from '../../types/core.js';
import { badInput, classifyExecutorDoctorCode } from '../../core/error-classification.js';
import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { queryTimeoutError } from '../../core/query-timeout.js';
import { nowIso } from '../../core/time.js';
import { str } from '../../core/strings.js';

const LATEST_OFFSET = -1n;
const EARLIEST_OFFSET = -2n;
const TIMEOUT_CODE = 'PLT_KFK_TIMEOUT';

type CallOptions = Pick<QueryRequest, 'timeoutMs' | 'signal'>

interface Table { columns: string[]; rows: unknown[][] }

async function openAdmin(ds: QueryRequest['datasource'], creds: Record<string, string>, timeoutMs: number | undefined): Promise<Admin> {
  const { Admin: AdminClient } = await import('@platformatic/kafka');
  const host = str(ds.connection.host || '127.0.0.1');
  const port = Number(ds.connection.port || 9092);
  const requestTimeout = timeoutMs && timeoutMs > 0 ? timeoutMs : RUNTIME_CONSTANTS.plugin.dbConnectTimeoutMs;
  const sasl = creds.user && creds.password
    ? { mechanism: 'PLAIN' as const, username: String(creds.user), password: String(creds.password) }
    : undefined;
  return new AdminClient({
    clientId: 'taproot',
    bootstrapBrokers: [`${host}:${port}`],
    connectTimeout: RUNTIME_CONSTANTS.plugin.dbConnectTimeoutMs,
    timeout: requestTimeout,
    requestTimeout,
    retries: 1,
    ...(ds.connection.ssl ? { tls: {} } : {}),
    ...(sasl ? { sasl } : {}),
  });
}

async function abortable<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  let onAbort: () => void = () => undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([work, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

function isTimeout(error: unknown): boolean {
  const { code, errors } = error as { code?: string; errors?: unknown[] };
  return code === TIMEOUT_CODE || Boolean(errors?.some(isTimeout));
}

async function withAdmin<T>(ds: QueryRequest['datasource'], creds: Record<string, string>, { timeoutMs, signal }: CallOptions, run: (admin: Admin) => Promise<T>): Promise<T> {
  signal?.throwIfAborted();
  const admin = await openAdmin(ds, creds, timeoutMs);
  try {
    return await abortable(run(admin), signal);
  } catch (error) {
    signal?.throwIfAborted();
    if (timeoutMs && isTimeout(error)) throw queryTimeoutError(timeoutMs);
    throw error;
  } finally {
    await admin.close().catch(() => undefined);
  }
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

function text(offset: bigint | undefined): string | null {
  return offset === undefined ? null : String(offset);
}

async function offsetsAt(admin: Admin, partitionsByTopic: Map<string, number[]>, timestamp: bigint): Promise<Map<string, Map<number, bigint>>> {
  const topics = [...partitionsByTopic]
    .filter(([, partitions]) => partitions.length > 0)
    .map(([name, partitions]) => ({ name, partitions: partitions.map((partitionIndex) => ({ partitionIndex, timestamp })) }));
  const listed = topics.length ? await admin.listOffsets({ topics }) : [];
  return new Map(listed.map((t) => [t.name, new Map(t.partitions.map((p) => [p.partitionIndex, p.offset]))]));
}

async function topics(admin: Admin, tokens: string[]): Promise<Table> {
  const match = matchFilter(tokens, 'topics');
  const names = (await admin.listTopics()).filter((t) => !match || match.test(t));
  const meta = names.length ? (await admin.metadata({ topics: names })).topics : new Map();
  const rows = [...meta]
    .map(([name, t]) => [name, t.partitionsCount, t.partitions[0]?.replicas.length ?? 0])
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return { columns: ['topic', 'partitions', 'replicationFactor'], rows };
}

async function describe(admin: Admin, tokens: string[]): Promise<Table> {
  if (tokens.length !== 2) throw badInput('kafka describe takes exactly one topic: describe <topic>.');
  const topic = String(tokens[1]);
  const partitions = (await admin.metadata({ topics: [topic] })).topics.get(topic)?.partitions || [];
  const requested = new Map([[topic, partitions.map((_, index) => index)]]);
  const [low, high] = await Promise.all([offsetsAt(admin, requested, EARLIEST_OFFSET), offsetsAt(admin, requested, LATEST_OFFSET)]);
  const rows = partitions.map((p, index) => [index, p.leader, p.replicas.join(','), p.isr.join(','), text(low.get(topic)?.get(index)), text(high.get(topic)?.get(index))]);
  return { columns: ['partition', 'leader', 'replicas', 'isr', 'logStart', 'logEnd'], rows };
}

async function groups(admin: Admin, tokens: string[]): Promise<Table> {
  const match = matchFilter(tokens, 'groups');
  const ids = [...(await admin.listGroups()).keys()].filter((g) => !match || match.test(g));
  const described = ids.length ? await admin.describeGroups({ groups: ids }) : new Map();
  const rows = [...described.values()].map((g) => [g.id, g.state, g.protocol]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return { columns: ['group', 'state', 'protocol'], rows };
}

interface CommittedPartition { partitionIndex: number; committedOffset: bigint }

interface LagRow { cells: unknown[]; hasCommit: boolean }

function lagRows(topic: string, partitions: CommittedPartition[], ends: Map<number, bigint> | undefined): LagRow[] {
  return [...partitions]
    .sort((a, b) => a.partitionIndex - b.partitionIndex)
    .map((p) => {
      const hasCommit = p.committedOffset >= 0n;
      const logEnd = ends?.get(p.partitionIndex);
      const lag = hasCommit && logEnd !== undefined ? Number(logEnd - p.committedOffset) : null;
      return { cells: [topic, p.partitionIndex, hasCommit ? String(p.committedOffset) : null, text(logEnd), lag], hasCommit };
    });
}

async function lagForGroup(admin: Admin, groupId: string): Promise<Table> {
  const columns = ['topic', 'partition', 'committed', 'logEnd', 'lag'];
  const described = await admin.describeGroups({ groups: [groupId] });
  if (described.get(groupId)?.state === 'Dead') throw badInput(`kafka consumer group '${groupId}' does not exist; list groups with: groups.`);
  const [group] = await admin.listConsumerGroupOffsets({ groups: [groupId] });
  const committed = [...(group?.topics || [])].sort((a, b) => a.name.localeCompare(b.name));
  const ends = await offsetsAt(admin, new Map(committed.map((t) => [t.name, t.partitions.map((p) => p.partitionIndex)])), LATEST_OFFSET);
  return { columns, rows: committed.flatMap((t) => lagRows(t.name, t.partitions, ends.get(t.name)).map((r) => r.cells)) };
}

async function lagForTopic(admin: Admin, topic: string): Promise<Table> {
  const columns = ['group', 'topic', 'partition', 'committed', 'logEnd', 'lag'];
  const count = (await admin.metadata({ topics: [topic] })).topics.get(topic)?.partitionsCount ?? 0;
  const partitionIndexes = Array.from({ length: count }, (_, index) => index);
  const ids = [...(await admin.listGroups()).keys()].sort();
  if (!ids.length || !count) return { columns, rows: [] };
  const [ends, offsets] = await Promise.all([
    offsetsAt(admin, new Map([[topic, partitionIndexes]]), LATEST_OFFSET),
    admin.listConsumerGroupOffsets({ groups: ids.map((groupId) => ({ groupId, topics: [{ name: topic, partitionIndexes }] })) }),
  ]);
  const rows = [...offsets]
    .sort((a, b) => a.groupId.localeCompare(b.groupId))
    .flatMap((g) => {
      const groupRows = g.topics.filter((t) => t.name === topic).flatMap((t) => lagRows(t.name, t.partitions, ends.get(t.name)));
      return groupRows.some((r) => r.hasCommit) ? groupRows.map((r) => [g.groupId, ...r.cells]) : [];
    });
  return { columns, rows };
}

async function lag(admin: Admin, tokens: string[]): Promise<Table> {
  const selector = tokens[1]?.toUpperCase();
  if (tokens.length !== 3 || (selector !== 'GROUP' && selector !== 'TOPIC')) {
    throw badInput('kafka lag needs exactly one selector: lag GROUP <id> or lag TOPIC <name>.');
  }
  const value = String(tokens[2]);
  return selector === 'GROUP' ? lagForGroup(admin, value) : lagForTopic(admin, value);
}

const VERBS: Record<string, (admin: Admin, tokens: string[]) => Promise<Table>> = {
  TOPICS: topics,
  DESCRIBE: describe,
  GROUPS: groups,
  LAG: lag,
};

export const kafkaPlugin: TapRootPlugin = {
  manifest: {
    name: 'kafka',
    capabilities: ['doctor', 'executeRead'],
  },

  async doctor(input): Promise<DoctorCheck[]> {
    try {
      const count = await withAdmin(input.datasource, input.credentials, { signal: undefined }, async (admin) => (await admin.listTopics()).length);
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
    const table = await withAdmin(request.datasource, creds, request, (admin) => run(admin, tokens));
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
