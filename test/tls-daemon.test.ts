import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildContext } from '../src/core/app.js';
import { RUNTIME_CONSTANTS } from '../src/core/constants.js';
import { TAPROOT_VERSION } from '../src/core/version.js';
import { remoteRpcCall } from '../src/daemon/client.js';
import { DATASOURCE_COLUMNS, type DatasourceColumn } from '../src/core/datasource-list.js';
import type { DatasourceCheck } from '../src/daemon/datasource-check.js';
import { datasourceListMethod, schemaMethod } from '../src/daemon/methods/catalog.js';
import { queryMethod, type QueryMethodOptions } from '../src/daemon/methods/query.js';
import { startDaemon, type DaemonLog } from '../src/daemon/server.js';
import { mutualTlsClientOptions, type HostPort, type MutualTlsFiles } from '../src/daemon/transport.js';
import { CredentialStore } from '../src/store/credentials.js';
import type { DatasourceProfile, TapRootPlugin } from '../src/types/core.js';
import { tlsPort } from './helpers/daemon.js';
import { fakePlugin } from './helpers/fake-plugin.js';
import { createTestPki, type TestPki } from './helpers/mutual-tls.js';
import { restoreQueryEnv, setupQueryState } from './helpers/query-state.js';

let pki: TestPki;
let otherPki: TestPki;
const running: Array<() => Promise<void>> = [];

beforeAll(() => {
  pki = createTestPki();
  otherPki = createTestPki();
});

afterEach(async () => {
  for (const stop of running.splice(0)) await stop();
  restoreQueryEnv();
});

interface TlsDaemonInput {
  files?: MutualTlsFiles;
  plugin?: TapRootPlugin;
  profile?: Partial<DatasourceProfile>;
  query?: QueryMethodOptions;
  checkDatasource?: DatasourceCheck;
  listColumns?: DatasourceColumn[];
  reloadMs?: number;
  log?: DaemonLog;
}

async function tlsDaemon(input: TlsDaemonInput = {}): Promise<HostPort> {
  await setupQueryState(input.profile);
  const daemon = await startDaemon({
    ctx: buildContext({ kbDir: undefined, verbose: false, plugins: [input.plugin ?? fakePlugin()], useKeychain: false }),
    listen: { kind: 'tls', host: '127.0.0.1', port: 0, tls: input.files ?? pki.daemon, reloadMs: input.reloadMs ?? 60_000 },
    methods: [queryMethod(input.query), datasourceListMethod({ columns: input.listColumns ?? DATASOURCE_COLUMNS }), schemaMethod()],
    checkDatasource: input.checkDatasource,
    log: input.log ?? (() => undefined),
  });
  running.push(daemon.stop);
  return { host: '127.0.0.1', port: tlsPort(daemon) };
}

function callAs(files: MutualTlsFiles, server: HostPort, method: string, params: Record<string, unknown>) {
  return remoteRpcCall({ server, tls: files, method, params, timeoutMs: 5_000 });
}

const readOk = (server: HostPort, files: MutualTlsFiles = pki.client) =>
  callAs(files, server, 'query.execute', { datasource: 'qa-fake', query: 'SELECT 1 AS ok' });

function requestLine(overrides: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ protocolVersion: RUNTIME_CONSTANTS.protocolVersion, clientVersion: TAPROOT_VERSION, requestId: 'r1', method: 'query.execute', params: { datasource: 'qa-fake', query: 'SELECT 1' }, ...overrides })}\n`;
}

function rawReply(server: HostPort, clientCertificate: MutualTlsFiles | undefined, payload: string): Promise<string> {
  return new Promise((resolve) => {
    const socket = clientCertificate
      ? tls.connect(mutualTlsClientOptions(clientCertificate, server))
      : tls.connect({ ...server, ca: fs.readFileSync(pki.client.caFile), minVersion: 'TLSv1.3' });
    let reply = '';
    socket.setEncoding('utf8');
    socket.on('secureConnect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      reply += chunk;
      if (reply.includes('\n')) socket.end();
    });
    socket.on('error', () => undefined);
    socket.on('close', () => resolve(reply));
  });
}

function copyOf(files: MutualTlsFiles): MutualTlsFiles {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-served-'));
  const copy = (source: string) => {
    const target = path.join(dir, path.basename(source));
    fs.copyFileSync(source, target);
    return target;
  };
  return { caFile: copy(files.caFile), certFile: copy(files.certFile), keyFile: copy(files.keyFile) };
}

describe('daemon over mutual TLS', () => {
  it('answers a client whose certificate comes from its CA', async () => {
    // arrange
    const server = await tlsDaemon();

    // act
    const res = await readOk(server);

    // assert
    expect(res).toMatchObject({ ok: true, data: { columns: ['ok'], rows: [[1]] } });
  });

  it('sends nothing back to a client without a certificate', async () => {
    // arrange
    const server = await tlsDaemon();

    // act
    const reply = await rawReply(server, undefined, requestLine());

    // assert
    expect(reply).toBe('');
  });

  it('closes the connection when a request line grows past 1 MiB and reports the drop', async () => {
    // arrange
    const events: Array<Record<string, unknown>> = [];
    const server = await tlsDaemon({ log: (event) => events.push(event) });

    // act
    const reply = await rawReply(server, pki.client, 'x'.repeat(1024 * 1024 + 1));

    // assert
    expect(reply).toBe('');
    expect(events).toEqual([{ requestDropped: 'request line over 1048576 characters', peer: '127.0.0.1' }]);
  });

  it('tells a client of another version to match versions and keeps serving', async () => {
    // arrange
    const server = await tlsDaemon();

    // act
    const mismatch = JSON.parse(await rawReply(server, pki.client, requestLine({ clientVersion: '0.0.0' })));
    const next = await readOk(server);

    // assert
    expect(mismatch.error).toEqual({ code: 'DAEMON_VERSION_MISMATCH', message: `this daemon runs ${TAPROOT_VERSION} and the client runs 0.0.0; run the same version on both sides.` });
    expect(next.ok).toBe(true);
  });

  it('refuses a client certificate from another CA', async () => {
    // arrange
    const server = await tlsDaemon();
    const strangerWithOurCa = { ...otherPki.client, caFile: pki.client.caFile };

    // act
    const call = readOk(server, strangerWithOurCa);

    // assert
    await expect(call).rejects.toThrow();
  });

  it('keeps the client from talking to a daemon whose certificate comes from another CA', async () => {
    // arrange
    const execute = vi.fn(fakePlugin().execute);
    const impostor = await tlsDaemon({ files: { ...otherPki.daemon, caFile: pki.client.caFile }, plugin: { ...fakePlugin(), execute } });

    // act
    const call = readOk(impostor);

    // assert
    await expect(call).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
  });

  it('fills env and service from the profile of the datasource a client names', async () => {
    // arrange
    const server = await tlsDaemon();

    // act
    const res = await readOk(server);

    // assert
    expect((res.meta as Record<string, unknown>).resolved).toMatchObject({ env: 'qa', service: 'fake' });
  });

  it('refuses a reload interval that is not positive', async () => {
    // act
    const start = tlsDaemon({ reloadMs: 0 });

    // assert
    await expect(start).rejects.toThrow('BAD_INPUT: listen.reloadMs must be a positive number of milliseconds, got 0.');
  });

  it('answers a method it was not given as unknown', async () => {
    // arrange
    const server = await tlsDaemon();

    // act
    const res = await callAs(pki.client, server, 'daemon.stop', {});

    // assert
    expect(res.error?.code).toBe('UNKNOWN_METHOD');
  });
});

describe('daemon log', () => {
  async function loggedDaemon() {
    const events: Array<Record<string, unknown>> = [];
    const server = await tlsDaemon({ log: (event) => events.push(event) });
    return { server, events };
  }

  it('reports a client whose certificate comes from another CA', async () => {
    // arrange
    const { server, events } = await loggedDaemon();
    const strangerWithOurCa = { ...otherPki.client, caFile: pki.client.caFile };

    // act
    await readOk(server, strangerWithOurCa).catch(() => undefined);

    // assert
    await vi.waitFor(() => expect(events).toEqual([{ tlsClientError: expect.any(String) }]));
  });

  it('reports a request it answered with an error', async () => {
    // arrange
    const { server, events } = await loggedDaemon();

    // act
    const res = await callAs(pki.client, server, 'schema.read', { datasource: 'qa-nope' });

    // assert
    expect(events).toEqual([{
      requestFailed: 'schema.read',
      code: 'UNKNOWN_DATASOURCE',
      message: res.error?.message,
      requestId: res.requestId,
      durationMs: expect.any(Number),
      peer: '127.0.0.1',
    }]);
  });

  it('stays quiet for a request it answered', async () => {
    // arrange
    const { server, events } = await loggedDaemon();

    // act
    await readOk(server);

    // assert
    expect(events).toEqual([]);
  });
});

describe('daemon certificate rotation', () => {
  async function rotatableDaemon() {
    const served = copyOf(pki.daemon);
    const events: Array<Record<string, unknown>> = [];
    const server = await tlsDaemon({ files: served, reloadMs: 25, log: (event) => events.push(event) });
    return { server, served, events };
  }

  const reads = (server: HostPort, files: MutualTlsFiles) => readOk(server, files).then((reply) => reply.ok, () => false);

  it('serves a rotated certificate without a restart', async () => {
    // arrange
    const { server, served, events } = await rotatableDaemon();

    // act
    fs.copyFileSync(otherPki.daemon.caFile, served.caFile);
    fs.copyFileSync(otherPki.daemon.certFile, served.certFile);
    fs.copyFileSync(otherPki.daemon.keyFile, served.keyFile);
    await vi.waitFor(() => expect(events).toContainEqual({ tlsReload: 'applied' }));

    // assert
    expect(await reads(server, otherPki.client)).toBe(true);
    expect(await reads(server, pki.client)).toBe(false);
  });

  it('keeps serving the old certificate while a rotation is half written', async () => {
    // arrange
    const { server, served, events } = await rotatableDaemon();

    // act
    fs.copyFileSync(otherPki.daemon.certFile, served.certFile);
    await vi.waitFor(() => expect(events.some((event) => event.tlsReload === 'failed')).toBe(true));

    // assert
    expect(await reads(server, pki.client)).toBe(true);
    expect(events).not.toContainEqual({ tlsReload: 'applied' });
  });
});

describe('query request shaper', () => {
  it('runs the request the shaper returns', async () => {
    // arrange
    const execute = vi.fn(fakePlugin().execute);
    const server = await tlsDaemon({
      plugin: { ...fakePlugin(), execute },
      query: { shapeRequest: (request) => ({ ...request, allowMutate: false }) },
    });

    // act
    const res = await callAs(pki.client, server, 'query.execute', { datasource: 'qa-fake', query: 'DELETE FROM orders', allowMutate: true });

    // assert
    expect(res.error?.message).toContain('Mutating query detected');
    expect(execute).not.toHaveBeenCalled();
  });
});

describe('datasource check', () => {
  it('refuses a datasource its check rejects, on query and schema, before the plugin runs', async () => {
    // arrange
    const plugin = fakePlugin({ kind: 'mysql', columns: ['table_name', 'column_name'], rows: [['orders', 'id']] });
    const execute = vi.fn(plugin.execute);
    const checkDatasource: DatasourceCheck = async ({ datasource }) => {
      throw new Error(`'${datasource.name}' is not allowed here`);
    };
    const server = await tlsDaemon({ plugin: { ...plugin, execute }, profile: { kind: 'mysql' }, checkDatasource });

    // act
    const query = await readOk(server);
    const schema = await callAs(pki.client, server, 'schema.read', { datasource: 'qa-fake' });

    // assert
    const refusal = { code: 'DATASOURCE_REFUSED', message: "DATASOURCE_REFUSED: 'qa-fake' is not allowed here" };
    expect(query.error).toMatchObject(refusal);
    expect(schema.error).toMatchObject(refusal);
    expect(execute).not.toHaveBeenCalled();
  });

  it('checks a datasource once, and again after a check that failed', async () => {
    // arrange
    const checkDatasource = vi.fn<DatasourceCheck>()
      .mockRejectedValueOnce(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }))
      .mockResolvedValue(undefined);
    const server = await tlsDaemon({ checkDatasource });

    // act
    const replies = [await readOk(server), await readOk(server), await readOk(server)];

    // assert
    expect(replies.map((reply) => reply.ok)).toEqual([false, true, true]);
    expect(replies[0].error?.code).toBe('CONNECTIVITY');
    expect(checkDatasource).toHaveBeenCalledTimes(2);
  });

  it('refuses with its own class when the refusal text reads like a network error', async () => {
    // arrange
    const checkDatasource: DatasourceCheck = async () => {
      throw new Error('the network zone of this datasource is closed');
    };
    const server = await tlsDaemon({ checkDatasource });

    // act
    const res = await readOk(server);

    // assert
    expect(res.error?.code).toBe('DATASOURCE_REFUSED');
  });

  it('gives up on a check that outlasts the query timeout and checks again next time', async () => {
    // arrange
    const checkDatasource = vi.fn<DatasourceCheck>()
      .mockReturnValueOnce(new Promise(() => undefined))
      .mockResolvedValue(undefined);
    const server = await tlsDaemon({ checkDatasource });
    const read = () => callAs(pki.client, server, 'query.execute', { datasource: 'qa-fake', query: 'SELECT 1 AS ok', timeoutMs: 50 });

    // act
    const replies = [await read(), await read()];

    // assert
    expect(replies.map((reply) => reply.error?.code ?? 'ok')).toEqual(['QUERY_TIMEOUT', 'ok']);
    expect(checkDatasource).toHaveBeenCalledTimes(2);
  });

  it('aborts the signal of a check that outlasts the query timeout', async () => {
    // arrange
    const checkDatasource = vi.fn<DatasourceCheck>().mockReturnValue(new Promise(() => undefined));
    const server = await tlsDaemon({ checkDatasource });

    // act
    await callAs(pki.client, server, 'query.execute', { datasource: 'qa-fake', query: 'SELECT 1 AS ok', timeoutMs: 50 });

    // assert
    expect(checkDatasource.mock.calls[0][0].signal.aborted).toBe(true);
  });

  it('checks a datasource again when its stored credentials change', async () => {
    // arrange
    const checkDatasource = vi.fn<DatasourceCheck>().mockResolvedValue(undefined);
    const server = await tlsDaemon({ checkDatasource });
    await readOk(server);

    // act
    await new CredentialStore(path.join(process.env.TAPROOT_STATE_ROOT!, 'config', 'credentials.json.enc'), false).set('qa:fake', { user: 'other', password: 'y' });
    await readOk(server);

    // assert
    expect(checkDatasource).toHaveBeenCalledTimes(2);
    expect(checkDatasource.mock.calls[1][0].credentials).toEqual({ user: 'other', password: 'y' });
  });
});

describe('catalog methods', () => {
  const catalogDaemon = () => tlsDaemon({
    plugin: fakePlugin({ kind: 'mysql', columns: ['table_name', 'column_name'], rows: [['orders', 'id'], ['orders', 'note']] }),
    profile: { kind: 'mysql' },
  });

  it('lists the datasources with the same columns as the CLI listing', async () => {
    // arrange
    const server = await tlsDaemon();

    // act
    const res = await callAs(pki.client, server, 'datasource.list', {});

    // assert
    expect(res.data).toEqual({
      columns: ['name', 'kind', 'env', 'service', 'host', 'database'],
      rows: [['qa-fake', 'fake', 'qa', 'fake', '127.0.0.1', 'fake']],
    });
  });

  it('lists only the columns the daemon serves', async () => {
    // arrange
    const server = await tlsDaemon({ listColumns: ['name', 'kind'] });

    // act
    const res = await callAs(pki.client, server, 'datasource.list', { detailed: true });

    // assert
    expect(res.data).toEqual({ columns: ['name', 'kind'], rows: [['qa-fake', 'fake']] });
  });

  it('adds the detailed columns it serves only when the client asks', async () => {
    // arrange
    const server = await tlsDaemon({ listColumns: ['name', 'confidence'] });

    // act
    const plain = await callAs(pki.client, server, 'datasource.list', {});
    const detailed = await callAs(pki.client, server, 'datasource.list', { detailed: true });

    // assert
    expect(plain.data).toEqual({ columns: ['name'], rows: [['qa-fake']] });
    expect(detailed.data).toEqual({ columns: ['name', 'confidence'], rows: [['qa-fake', 1]] });
  });

  it('refuses a column it does not know', () => {
    // act
    const build = () => datasourceListMethod({ columns: ['name', 'password'] as DatasourceColumn[] });

    // assert
    expect(build).toThrow('unknown datasource columns: password');
  });

  it('lists the table names of a datasource', async () => {
    // arrange
    const server = await catalogDaemon();

    // act
    const res = await callAs(pki.client, server, 'schema.read', { datasource: 'qa-fake' });

    // assert
    expect(res.data).toEqual({ tables: ['orders'] });
  });

  it('describes the tables asked for, whatever their case', async () => {
    // arrange
    const server = await catalogDaemon();

    // act
    const res = await callAs(pki.client, server, 'schema.read', { datasource: 'qa-fake', tables: ['ORDERS'] });

    // assert
    expect(res.data).toEqual({ tables: { orders: { columns: ['id', 'note'] } } });
  });

  it('suggests close names for a table the datasource does not have', async () => {
    // arrange
    const server = await catalogDaemon();

    // act
    const res = await callAs(pki.client, server, 'schema.read', { datasource: 'qa-fake', tables: ['ordrs'] });

    // assert
    expect(res.error).toMatchObject({ code: 'UNKNOWN_TABLE', details: { didYouMean: ['orders'] } });
  });

  it('names the datasource it does not know', async () => {
    // arrange
    const server = await catalogDaemon();

    // act
    const res = await callAs(pki.client, server, 'schema.read', { datasource: 'qa-nope' });

    // assert
    expect(res.error?.code).toBe('UNKNOWN_DATASOURCE');
  });
});
