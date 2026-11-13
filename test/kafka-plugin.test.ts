import { Admin, Consumer, Producer } from '@platformatic/kafka';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { kafkaPlugin } from '../src/plugins-builtins/kafka/index.js';
import type { DatasourceProfile, QueryRequest } from '../src/types/core.js';

vi.mock('@platformatic/kafka', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@platformatic/kafka')>()),
  Admin: vi.fn(),
  Consumer: vi.fn(),
  Producer: vi.fn(),
}));

const LATEST = -1n;

function datasource(): DatasourceProfile {
  return {
    name: 'qa-events',
    kind: 'kafka',
    env: 'qa',
    tags: [],
    connection: { host: '127.0.0.1', port: 9092 },
    credentialRef: 'qa-events',
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    updatedAt: new Date().toISOString(),
    confidence: 0.9,
  };
}

function read(query: string, overrides: Partial<QueryRequest> = {}): QueryRequest {
  return { datasource: datasource(), query, capability: 'executeRead', timeoutMs: 5000, sessionTimeZone: '+00:00', signal: undefined, ...overrides };
}

const ENDS: Record<string, Array<{ low: bigint; high: bigint }>> = {
  'orders.created': [{ low: 0n, high: 10n }, { low: 2n, high: 7n }],
  'billing.paid': [{ low: 0n, high: 3n }],
};

const COMMITS: Record<string, Record<string, bigint[]>> = {
  'orders-reader': { 'orders.created': [8n, -1n] },
  'billing-reader': { 'billing.paid': [3n] },
};

interface FakeAdmin {
  listTopics: ReturnType<typeof vi.fn>;
  metadata: ReturnType<typeof vi.fn>;
  listOffsets: ReturnType<typeof vi.fn>;
  listGroups: ReturnType<typeof vi.fn>;
  describeGroups: ReturnType<typeof vi.fn>;
  listConsumerGroupOffsets: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function fakeAdmin(): FakeAdmin {
  return {
    listTopics: vi.fn(async () => ['orders.created', 'billing.paid']),
    metadata: vi.fn(async ({ topics }: { topics: string[] }) => ({
      topics: new Map(topics.map((name) => {
        const partitions = (ENDS[name] || [{ low: 0n, high: 0n }]).map(() => ({ leader: 1, replicas: [1, 2], isr: [1, 2] }));
        return [name, { partitionsCount: partitions.length, partitions }];
      })),
    })),
    listOffsets: vi.fn(async ({ topics }: { topics: Array<{ name: string; partitions: Array<{ partitionIndex: number; timestamp: bigint }> }> }) =>
      topics.map((t) => ({
        name: t.name,
        partitions: t.partitions.map((p) => ({
          partitionIndex: p.partitionIndex,
          offset: p.timestamp === LATEST ? ENDS[t.name]?.[p.partitionIndex]?.high : ENDS[t.name]?.[p.partitionIndex]?.low,
        })),
      }))),
    listGroups: vi.fn(async () => new Map([
      ['orders-reader', { id: 'orders-reader', state: 'Stable', protocolType: 'consumer' }],
      ['billing-reader', { id: 'billing-reader', state: 'Stable', protocolType: 'consumer' }],
    ])),
    describeGroups: vi.fn(async ({ groups }: { groups: string[] }) =>
      new Map(groups.map((id) => [id, { id, state: COMMITS[id] ? 'Stable' : 'Dead', protocol: COMMITS[id] ? 'range' : '' }]))),
    listConsumerGroupOffsets: vi.fn(async ({ groups }: { groups: Array<string | { groupId: string; topics?: Array<{ name: string }> }> }) =>
      groups.map((g) => {
        const groupId = typeof g === 'string' ? g : g.groupId;
        const wanted = typeof g === 'string' ? undefined : g.topics?.map((t) => t.name);
        const topics = Object.entries(COMMITS[groupId] || {})
          .filter(([name]) => !wanted || wanted.includes(name))
          .map(([name, offsets]) => ({ name, partitions: offsets.map((committedOffset, partitionIndex) => ({ partitionIndex, committedOffset })) }));
        const missing = (wanted || []).filter((name) => !topics.some((t) => t.name === name));
        return {
          groupId,
          topics: topics.concat(missing.map((name) => ({ name, partitions: (ENDS[name] || []).map((_, partitionIndex) => ({ partitionIndex, committedOffset: -1n })) }))),
        };
      })),
    close: vi.fn(async () => undefined),
  };
}

let admin: FakeAdmin;

beforeEach(() => {
  vi.mocked(Admin).mockReset();
  vi.mocked(Consumer).mockReset();
  vi.mocked(Producer).mockReset();
  admin = fakeAdmin();
  vi.mocked(Admin).mockImplementation(function () { return admin as never; });
});

describe('kafka plugin', () => {
  it('declares no mutate capability', () => {
    // act / assert
    expect(kafkaPlugin.manifest.capabilities).toEqual(['doctor', 'executeRead']);
  });

  it('constructs only an admin client, never a consumer or producer', async () => {
    // act
    await kafkaPlugin.execute!(read('topics'), {});
    await kafkaPlugin.execute!(read('lag GROUP orders-reader'), {});

    // assert
    expect(Admin).toHaveBeenCalledTimes(2);
    expect(Consumer).not.toHaveBeenCalled();
    expect(Producer).not.toHaveBeenCalled();
  });

  it('connects to the datasource broker with plain credentials as SASL and ssl as tls', async () => {
    // arrange
    const request = read('topics');
    request.datasource.connection = { host: 'broker.example', port: 9093, ssl: true };

    // act
    await kafkaPlugin.execute!(request, { user: 'reader', password: 'secret' });

    // assert
    expect(Admin).toHaveBeenCalledWith(expect.objectContaining({
      bootstrapBrokers: ['broker.example:9093'],
      tls: {},
      sasl: { mechanism: 'PLAIN', username: 'reader', password: 'secret' },
    }));
  });

  it('passes the query timeout to the broker client', async () => {
    // act
    await kafkaPlugin.execute!(read('topics', { timeoutMs: 1234 }), {});

    // assert
    expect(Admin).toHaveBeenCalledWith(expect.objectContaining({ timeout: 1234, requestTimeout: 1234 }));
  });

  it('reports a broker timeout as QUERY_TIMEOUT', async () => {
    // arrange
    admin.listTopics.mockRejectedValue(Object.assign(new Error('Request timed out'), { code: 'PLT_KFK_TIMEOUT' }));

    // act
    const run = kafkaPlugin.execute!(read('topics', { timeoutMs: 1234 }), {});

    // assert
    await expect(run).rejects.toMatchObject({ code: 'QUERY_TIMEOUT' });
  });

  it('rejects with the abort reason and closes the client when the signal aborts mid-call', async () => {
    // arrange
    const controller = new AbortController();
    admin.listTopics.mockImplementation(() => new Promise(() => undefined));

    // act
    const run = kafkaPlugin.execute!(read('topics', { signal: controller.signal }), {});
    await vi.waitFor(() => expect(admin.listTopics).toHaveBeenCalled());
    controller.abort(new Error('cancelled by caller'));

    // assert
    await expect(run).rejects.toThrow('cancelled by caller');
    expect(admin.close).toHaveBeenCalledTimes(1);
  });

  it('does not open a client when the signal is already aborted', async () => {
    // arrange
    const controller = new AbortController();
    controller.abort(new Error('cancelled by caller'));

    // act
    const run = kafkaPlugin.execute!(read('topics', { signal: controller.signal }), {});

    // assert
    await expect(run).rejects.toThrow('cancelled by caller');
    expect(Admin).not.toHaveBeenCalled();
  });

  it('lists topics filtered by MATCH with partition counts', async () => {
    // act
    const result = await kafkaPlugin.execute!(read('topics MATCH orders.*'), {});

    // assert
    expect(result.result.columns).toEqual(['topic', 'partitions', 'replicationFactor']);
    expect(result.result.rows).toEqual([['orders.created', 2, 2]]);
  });

  it('describes a topic per partition with log start and end', async () => {
    // act
    const result = await kafkaPlugin.execute!(read('describe orders.created'), {});

    // assert
    expect(result.result.rows).toEqual([[0, 1, '1,2', '1,2', '0', '10'], [1, 1, '1,2', '1,2', '2', '7']]);
  });

  it('lists groups with state', async () => {
    // act
    const result = await kafkaPlugin.execute!(read('groups'), {});

    // assert
    expect(result.result.rows).toEqual([['billing-reader', 'Stable', 'range'], ['orders-reader', 'Stable', 'range']]);
  });

  it('reports lag per partition for a group and never counts a missing commit as zero', async () => {
    // act
    const result = await kafkaPlugin.execute!(read('lag GROUP orders-reader'), {});

    // assert
    expect(result.result.columns).toEqual(['topic', 'partition', 'committed', 'logEnd', 'lag']);
    expect(result.result.rows).toEqual([
      ['orders.created', 0, '8', '10', 2],
      ['orders.created', 1, null, '7', null],
    ]);
  });

  it('fails with BAD_INPUT for a group the broker reports as Dead', async () => {
    // act
    const run = kafkaPlugin.execute!(read('lag GROUP nobody'), {});

    // assert
    await expect(run).rejects.toMatchObject({ code: 'BAD_INPUT' });
    await expect(run).rejects.toThrow(/nobody/);
  });

  it('lists only groups that committed on a topic for lag TOPIC with one offsets call', async () => {
    // act
    const result = await kafkaPlugin.execute!(read('lag TOPIC billing.paid'), {});

    // assert
    expect(result.result.columns).toEqual(['group', 'topic', 'partition', 'committed', 'logEnd', 'lag']);
    expect(result.result.rows).toEqual([['billing-reader', 'billing.paid', 0, '3', '3', 0]]);
    expect(admin.listConsumerGroupOffsets).toHaveBeenCalledTimes(1);
  });

  it('refuses lag without exactly one selector', async () => {
    // act
    const run = kafkaPlugin.execute!(read('lag'), {});

    // assert
    await expect(run).rejects.toThrow(/exactly one selector/);
  });

  it('refuses unknown verbs and still closes the client after a failure', async () => {
    // act
    const unknown = kafkaPlugin.execute!(read('produce orders.created hi'), {});
    const bad = kafkaPlugin.execute!(read('describe'), {});

    // assert
    await expect(unknown).rejects.toThrow(/not supported/);
    await expect(bad).rejects.toThrow(/exactly one topic/);
    expect(admin.close).toHaveBeenCalledTimes(vi.mocked(Admin).mock.calls.length);
  });

  it('doctor reports the broker answer', async () => {
    // act
    const checks = await kafkaPlugin.doctor!({ datasource: datasource(), credentials: {} });

    // assert
    expect(checks[0]).toEqual(expect.objectContaining({ status: 'ok', detail: 'broker answered; 2 topic(s)' }));
  });
});
