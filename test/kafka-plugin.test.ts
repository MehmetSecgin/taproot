import path from 'node:path';
import fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import { brokerSocketFactory, kafkaPlugin, parseBrokerMap, setKafkaAdminFactory, type KafkaAdmin } from '../src/plugins-builtins/kafka/index.js';
import type { DatasourceProfile, QueryRequest } from '../src/types/core.js';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';

function datasource(env = 'qa'): DatasourceProfile {
  return {
    name: `${env}-events`,
    kind: 'kafka',
    env,
    tags: [],
    connection: { host: '127.0.0.1', port: 9092 },
    credentialRef: `${env}-events`,
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    updatedAt: new Date().toISOString(),
    confidence: 0.9,
  };
}

function read(query: string): QueryRequest {
  return { datasource: datasource(), query, capability: 'executeRead', timeoutMs: 5000, sessionTimeZone: '+00:00', signal: undefined };
}

interface FakeState { connected: number; disconnected: number }

function fakeAdmin(state: FakeState): KafkaAdmin {
  const ends: Record<string, Array<{ partition: number; high: string; low: string }>> = {
    'orders.created': [{ partition: 0, high: '10', low: '0' }, { partition: 1, high: '7', low: '2' }],
    'billing.paid': [{ partition: 0, high: '3', low: '0' }],
  };
  const commits: Record<string, Array<{ topic: string; partitions: Array<{ partition: number; offset: string }> }>> = {
    'orders-reader': [{ topic: 'orders.created', partitions: [{ partition: 1, offset: '-1' }, { partition: 0, offset: '8' }] }],
    'billing-reader': [{ topic: 'billing.paid', partitions: [{ partition: 0, offset: '3' }] }],
  };
  return {
    connect: async () => { state.connected += 1; },
    disconnect: async () => { state.disconnected += 1; },
    listTopics: async () => ['orders.created', 'billing.paid', '__consumer_offsets'],
    fetchTopicMetadata: async ({ topics }) => ({
      topics: topics.map((name) => ({
        name,
        partitions: (ends[name] || [{ partition: 0, high: '0', low: '0' }]).map((e) => ({ partitionId: e.partition, leader: 1, replicas: [1, 2], isr: [1, 2] })),
      })),
    }),
    fetchTopicOffsets: async (topic) => ends[topic] || [],
    listGroups: async () => ({ groups: [{ groupId: 'orders-reader', protocolType: 'consumer' }, { groupId: 'billing-reader', protocolType: 'consumer' }] }),
    describeGroups: async (ids) => ({ groups: ids.map((groupId) => ({ groupId, state: 'Stable', protocol: 'range' })) }),
    fetchOffsets: async ({ groupId, topics }) => (commits[groupId] || [])
      .filter((t) => !topics || topics.includes(t.topic))
      .concat(topics && !(commits[groupId] || []).some((t) => topics.includes(t.topic))
        ? topics.map((topic) => ({ topic, partitions: (ends[topic] || []).map((e) => ({ partition: e.partition, offset: '-1' })) }))
        : []),
  };
}

function useFake(): FakeState {
  const state = { connected: 0, disconnected: 0 };
  setKafkaAdminFactory(async () => fakeAdmin(state));
  return state;
}

afterEach(() => setKafkaAdminFactory(undefined));

describe('kafka plugin', () => {
  it('declares no mutate capability', () => {
    // act / assert
    expect(kafkaPlugin.manifest.capabilities).toEqual(['doctor', 'executeRead']);
  });

  it('builds only an admin client, never a consumer or producer', () => {
    // arrange
    const source = fs.readFileSync(path.join(process.cwd(), 'src/plugins-builtins/kafka/index.ts'), 'utf8');

    // act
    const clients = source.match(/\.(consumer|producer|admin)\(/g) || [];

    // assert
    expect(clients).toEqual(['.admin(']);
  });

  it('lists topics filtered by MATCH with partition counts', async () => {
    // arrange
    useFake();

    // act
    const result = await kafkaPlugin.execute!(read('topics MATCH orders.*'), {});

    // assert
    expect(result.result.columns).toEqual(['topic', 'partitions', 'replicationFactor']);
    expect(result.result.rows).toEqual([['orders.created', 2, 2]]);
  });

  it('describes a topic per partition with log start and end', async () => {
    // arrange
    useFake();

    // act
    const result = await kafkaPlugin.execute!(read('describe orders.created'), {});

    // assert
    expect(result.result.rows).toEqual([[0, 1, '1,2', '1,2', '0', '10'], [1, 1, '1,2', '1,2', '2', '7']]);
  });

  it('lists groups with state', async () => {
    // arrange
    useFake();

    // act
    const result = await kafkaPlugin.execute!(read('groups'), {});

    // assert
    expect(result.result.rows).toEqual([['billing-reader', 'Stable', 'range'], ['orders-reader', 'Stable', 'range']]);
  });

  it('reports lag per partition and never counts a missing commit as zero', async () => {
    // arrange
    useFake();

    // act
    const result = await kafkaPlugin.execute!(read('lag GROUP orders-reader'), {});

    // assert
    expect(result.result.rows).toEqual([
      ['orders-reader', 'orders.created', 0, '8', '10', 2, false],
      ['orders-reader', 'orders.created', 1, null, '7', null, true],
    ]);
  });

  it('lists only groups that committed on a topic for lag TOPIC', async () => {
    // arrange
    useFake();

    // act
    const result = await kafkaPlugin.execute!(read('lag TOPIC billing.paid'), {});

    // assert
    expect(result.result.rows).toEqual([['billing-reader', 'billing.paid', 0, '3', '3', 0, false]]);
  });

  it('refuses lag without exactly one selector', async () => {
    // arrange
    useFake();

    // act
    const run = kafkaPlugin.execute!(read('lag'), {});

    // assert
    await expect(run).rejects.toThrow(/exactly one selector/);
  });

  it('refuses unknown verbs and still disconnects after a failure', async () => {
    // arrange
    const state = useFake();

    // act
    const unknown = kafkaPlugin.execute!(read('produce orders.created hi'), {});
    const bad = kafkaPlugin.execute!(read('describe'), {});

    // assert
    await expect(unknown).rejects.toThrow(/not supported/);
    await expect(bad).rejects.toThrow(/exactly one topic/);
    expect(state.connected).toBe(state.disconnected);
  });

  it('doctor reports the broker answer', async () => {
    // arrange
    useFake();

    // act
    const checks = await kafkaPlugin.doctor!({ datasource: datasource(), credentials: {} });

    // assert
    expect(checks[0]).toEqual(expect.objectContaining({ status: 'ok', detail: 'broker answered; 3 topic(s)' }));
  });

  it('refuses a datasource kind the environment policy denies, before connecting', () => {
    // arrange
    const { stateRoot, configDir } = tempStateRoot();
    fs.writeFileSync(path.join(configDir, 'datasources.json'), JSON.stringify([datasource('prod')]));
    fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');
    fs.writeFileSync(path.join(configDir, 'deterministic-config.json'), JSON.stringify({ environmentPolicies: { prod: { denyKinds: ['kafka'] } } }));

    // act
    const out = runCli(['query', '--datasource', 'prod-events', '--query', 'topics'], { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key' });

    // assert
    expect(out.status).not.toBe(0);
    expect(out.stdout).toContain('ACCESS_DENIED');
    expect(out.stdout).toContain("denies datasource kind 'kafka'");
  });
});

describe('kafka brokerMap hint', () => {
  async function connectThrough(factory: ReturnType<typeof brokerSocketFactory>, host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
      const socket = factory({ host, port, ssl: undefined as never, onConnect: () => { const remote = socket.remotePort as number; socket.end(); resolve(remote); } });
      socket.on('error', reject);
    });
  }

  async function listen(): Promise<{ server: net.Server; port: number }> {
    const server = net.createServer((s) => s.end());
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return { server, port: (server.address() as net.AddressInfo).port };
  }

  it('routes a mapped advertised broker to the local address', async () => {
    const { server, port } = await listen();
    try {
      const factory = brokerSocketFactory(parseBrokerMap(`broker-0.cluster.example:9092=127.0.0.1:${port}`));
      expect(await connectThrough(factory, 'broker-0.cluster.example', 9092)).toBe(port);
    } finally {
      server.close();
    }
  });

  it('connects unmapped brokers unchanged', async () => {
    const { server, port } = await listen();
    try {
      const factory = brokerSocketFactory(parseBrokerMap('broker-0.cluster.example:9092=127.0.0.1:1'));
      expect(await connectThrough(factory, '127.0.0.1', port)).toBe(port);
    } finally {
      server.close();
    }
  });

  it('parses several comma-separated entries', () => {
    expect([...parseBrokerMap('a:1=127.0.0.1:2, b:3=127.0.0.1:4')]).toEqual([['a:1', '127.0.0.1:2'], ['b:3', '127.0.0.1:4']]);
  });

  it.each(['broker-0:9092', 'broker-0=127.0.0.1:1', 'broker-0:9092=localhost', '=127.0.0.1:1'])('refuses bad syntax %s as BAD_INPUT naming the hint', (hint) => {
    expect(() => parseBrokerMap(hint)).toThrow(/brokerMap/);
    let error: unknown;
    try { parseBrokerMap(hint); } catch (e) { error = e; }
    expect((error as { code?: string }).code).toBe('BAD_INPUT');
  });
});
