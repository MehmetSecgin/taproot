import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildContext } from '../src/core/app.js';
import { executeQuery, silentQueryReport } from '../src/core/execute-query.js';
import type { QueryExecutionRequest } from '../src/core/execute-query.js';
import { rpcCall } from '../src/daemon/client.js';
import { startDaemon } from '../src/daemon/server.js';
import { CredentialStore } from '../src/store/credentials.js';
import { DatasourceStore } from '../src/store/datasources.js';
import type { QueryResult, TapRootPlugin } from '../src/types/core.js';
import { fakePlugin } from './helpers/fake-plugin.js';

function queryRecordingPlugin(seen: string[]): TapRootPlugin {
  const plugin = fakePlugin();
  const inner = plugin.execute!;
  plugin.execute = async (request, creds): Promise<QueryResult> => {
    seen.push(request.query);
    return inner(request, creds);
  };
  return plugin;
}

const previousEnv = {
  TAPROOT_STATE_ROOT: process.env.TAPROOT_STATE_ROOT,
  TAPROOT_MASTER_KEY: process.env.TAPROOT_MASTER_KEY,
  NODE_ENV: process.env.NODE_ENV,
};

let stateRoot = '';

function baseRequest(overrides: Partial<QueryExecutionRequest> = {}): QueryExecutionRequest {
  return {
    datasource: 'qa-fake',
    env: 'qa',
    namespace: '',
    service: 'fake',
    query: 'SELECT 1 AS ok',
    params: [],
    allowDiscovery: false,
    allowMutate: false,
    allowPartitionScan: false,
    explain: false,
    rowsObject: false,
    jsonExtract: [],
    allowFlush: false,
    skipProtoValidate: false,
    timeoutMs: 5_000,
    ...overrides,
  };
}

async function runBothPaths(request: QueryExecutionRequest, makePlugin: () => TapRootPlugin = () => fakePlugin()) {
  const addPlugin = (registry: Map<string, TapRootPlugin>) => {
    const plugin = makePlugin();
    registry.set(plugin.manifest.name, plugin);
  };
  const ctx = buildContext({});
  addPlugin(ctx.pluginRegistry);
  const direct = await executeQuery(request, { ctx, report: silentQueryReport });

  const socketPath = path.join(stateRoot, 'run', 'taprootd-parity.sock');
  const daemon = await startDaemon({
    stateRoot,
    socketPath,
    configurePlugins: addPlugin,
  });
  try {
    const rpc = await rpcCall({ socketPath, method: 'query.execute', params: { ...request }, timeoutMs: 10_000 });
    return { direct, rpc };
  } finally {
    await daemon.stop();
  }
}

beforeEach(async () => {
  stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-parity-'));
  process.env.TAPROOT_STATE_ROOT = stateRoot;
  process.env.TAPROOT_MASTER_KEY = 'test-master-key';
  process.env.NODE_ENV = 'test';
  const configDir = path.join(stateRoot, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const dsStore = new DatasourceStore(path.join(configDir, 'datasources.json'));
  dsStore.save({
    name: 'qa-fake',
    kind: 'fake',
    env: 'qa',
    service: 'fake',
    tags: [],
    connection: { host: '127.0.0.1', port: 1, database: 'fake' },
    credentialRef: 'qa:fake',
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    updatedAt: new Date().toISOString(),
    confidence: 1,
  });
  const creds = new CredentialStore(path.join(configDir, 'credentials.json.enc'));
  await creds.set('qa:fake', { user: 'x', password: 'x' });
});

afterEach(() => {
  process.env.TAPROOT_STATE_ROOT = previousEnv.TAPROOT_STATE_ROOT;
  process.env.TAPROOT_MASTER_KEY = previousEnv.TAPROOT_MASTER_KEY;
  process.env.NODE_ENV = previousEnv.NODE_ENV;
});

describe('query parity between the direct and daemon adapters', () => {
  it('produces the same success envelope on both paths', async () => {
    const { direct, rpc } = await runBothPaths(baseRequest());

    expect(direct.ok).toBe(true);
    expect(rpc.ok).toBe(true);
    if (!direct.ok) return;
    expect(rpc.data).toEqual(direct.data);
    expect(direct.data.columns).toEqual(['ok']);
    expect(direct.data.rows).toEqual([[1]]);
    expect(direct.data.rowsForm).toBe('array');
  });

  it('reports the same resolved metadata on both paths', async () => {
    const { direct, rpc } = await runBothPaths(baseRequest());
    if (!direct.ok) throw new Error('direct path failed');
    expect((rpc.meta as Record<string, unknown>)?.resolved).toEqual(direct.meta.resolved);
  });

  it('emits each warning exactly once on both paths', async () => {
    const { direct, rpc } = await runBothPaths(baseRequest(), () =>
      fakePlugin({ warnings: ['partition scan without predicate'] }),
    );
    if (!direct.ok) throw new Error('direct path failed');
    expect(direct.data.warnings).toEqual(['partition scan without predicate']);
    expect((rpc.data as Record<string, unknown>)?.warnings).toEqual(['partition scan without predicate']);
  });

  it('wraps the query with EXPLAIN on both paths', async () => {
    const seen: string[] = [];
    const { direct, rpc } = await runBothPaths(baseRequest({ explain: true }), () => queryRecordingPlugin(seen));

    expect(direct.ok).toBe(true);
    expect(rpc.ok).toBe(true);
    expect(seen).toEqual(['EXPLAIN SELECT 1 AS ok', 'EXPLAIN SELECT 1 AS ok']);
    if (!direct.ok) return;
    expect(rpc.data).toEqual(direct.data);
  });

  it('adds the json-extract derived column on both paths', async () => {
    const { direct, rpc } = await runBothPaths(baseRequest({ jsonExtract: ['payload:order.id'] }), () =>
      fakePlugin({ columns: ['payload'], rows: [['{"order":{"id":"A1"}}']] }),
    );

    if (!direct.ok) throw new Error('direct path failed');
    expect(direct.data.columns).toEqual(['payload', 'payload.order.id']);
    expect(direct.data.rows).toEqual([['{"order":{"id":"A1"}}', 'A1']]);
    expect(rpc.data).toEqual(direct.data);
  });

  it('rejects a malformed json-extract spec on both paths', async () => {
    const { direct, rpc } = await runBothPaths(baseRequest({ jsonExtract: ['payload'] }));

    expect(direct.ok).toBe(false);
    expect(rpc.ok).toBe(false);
    if (direct.ok) return;
    expect(direct.code).toBe('BAD_INPUT');
    expect(rpc.error?.code).toBe('BAD_INPUT');
  });

  it('rejects a malformed param on both paths', async () => {
    const { direct, rpc } = await runBothPaths(baseRequest({ params: ['brokenpair'] }));
    expect(direct.ok).toBe(false);
    expect(rpc.ok).toBe(false);
    if (direct.ok) return;
    expect(direct.message).toContain("Invalid --param 'brokenpair'");
    expect(rpc.error?.message).toContain("Invalid --param 'brokenpair'");
    expect(direct.code).toBe('BAD_INPUT');
    expect(rpc.error?.code).toBe('BAD_INPUT');
  });

  it('maps session and phase metadata onto the daemon response', async () => {
    const { rpc } = await runBothPaths(baseRequest());
    const meta = rpc.meta as Record<string, unknown>;
    expect(meta.sessionId).toBeTruthy();
    expect(meta.resolved).toBeDefined();
    expect(meta.phases).toMatchObject({ resolveMs: expect.any(Number), executeMs: expect.any(Number) });
  });

  it('returns rows as objects on both paths when rowsObject is set', async () => {
    const { direct, rpc } = await runBothPaths(baseRequest({ rowsObject: true }));
    if (!direct.ok) throw new Error('direct path failed');
    expect(direct.data.rows).toEqual([{ ok: 1 }]);
    expect(rpc.data).toEqual(direct.data);
  });
});
