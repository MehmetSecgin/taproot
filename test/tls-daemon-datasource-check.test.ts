import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { DatasourceCheck } from '../src/daemon/datasource-check.js';
import { CredentialStore } from '../src/store/credentials.js';
import type { QueryRequest } from '../src/types/plugin.js';
import { fakePlugin, interceptExecute } from './helpers/fake-plugin.js';
import { createNoop } from './helpers/noop.js';
import { waitMs } from '../src/core/wait.js';
import { useTlsDaemons } from './helpers/tls-daemon-fixture.js';

const refuseAsNotAllowed: DatasourceCheck = async ({ datasource }) => {
  await Promise.resolve();
  throw new Error(`'${datasource.name}' is not allowed here`);
};

const refuseWithNetworkWords: DatasourceCheck = async () => {
  await Promise.resolve();
  throw new Error('the network zone of this datasource is closed');
};

async function passes(): Promise<void> {
  await Promise.resolve();
}

describe('datasource check', () => {
  const tls = useTlsDaemons();

  it('refuses a datasource its check rejects, on query and schema, before the plugin runs', async () => {
    // arrange
    const plugin = fakePlugin({ kind: 'mysql', columns: ['table_name', 'column_name'], rows: [['orders', 'id']] });
    const execute = vi.fn<(request: QueryRequest) => void>();
    const server = await tls.startDaemon({ plugin: interceptExecute(plugin, execute), profile: { kind: 'mysql' }, checkDatasource: refuseAsNotAllowed });

    // act
    const query = await tls.readOk(server);
    const schema = await tls.call(server, 'schema.read', { datasource: 'qa-fake' });

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
      .mockImplementation(passes);
    const server = await tls.startDaemon({ checkDatasource });

    // act
    const replies = [await tls.readOk(server), await tls.readOk(server), await tls.readOk(server)];

    // assert
    expect(replies.map((reply) => reply.ok)).toStrictEqual([false, true, true]);
    expect(replies[0].error?.code).toBe('CONNECTIVITY');
    expect(checkDatasource).toHaveBeenCalledTimes(2);
  });

  it('refuses with its own class when the refusal text reads like a network error', async () => {
    // arrange
    const server = await tls.startDaemon({ checkDatasource: refuseWithNetworkWords });

    // act
    const res = await tls.readOk(server);

    // assert
    expect(res.error?.code).toBe('DATASOURCE_REFUSED');
  });

  it('gives up on a check that outlasts the query timeout and checks again next time', async () => {
    // arrange
    const checkDatasource = vi.fn<DatasourceCheck>()
      .mockReturnValueOnce(new Promise<void>(createNoop()))
      .mockImplementation(passes);
    const server = await tls.startDaemon({ checkDatasource });
    const read = async (): ReturnType<typeof tls.call> => tls.call(server, 'query.execute', { datasource: 'qa-fake', query: 'SELECT 1 AS ok', timeoutMs: 50 });

    // act
    const replies = [await read(), await read()];

    // assert
    expect(replies.map((reply) => reply.error?.code)).toStrictEqual(['QUERY_TIMEOUT', undefined]);
    expect(checkDatasource).toHaveBeenCalledTimes(2);
  });

  it('aborts the signal of a check that outlasts the query timeout', async () => {
    // arrange
    const checkDatasource = vi.fn<DatasourceCheck>().mockReturnValue(new Promise<void>(createNoop()));
    const server = await tls.startDaemon({ checkDatasource });

    // act
    await tls.call(server, 'query.execute', { datasource: 'qa-fake', query: 'SELECT 1 AS ok', timeoutMs: 50 });

    // assert
    expect(checkDatasource.mock.calls[0][0].signal.aborted).toBe(true);
  });

  it('checks a passed datasource again once its time limit runs out', async () => {
    // arrange
    const checkDatasource = vi.fn<DatasourceCheck>().mockImplementation(passes);
    const server = await tls.startDaemon({ checkDatasource, checkDatasourceTtlMs: 500 });
    await tls.readOk(server);
    await tls.readOk(server);
    const checksWithinLimit = checkDatasource.mock.calls.length;

    // act
    await waitMs(600);
    await tls.readOk(server);

    // assert
    expect(checksWithinLimit).toBe(1);
    expect(checkDatasource).toHaveBeenCalledTimes(2);
  });

  it('checks a datasource again when its stored credentials change', async () => {
    // arrange
    const checkDatasource = vi.fn<DatasourceCheck>().mockImplementation(passes);
    const server = await tls.startDaemon({ checkDatasource });
    await tls.readOk(server);

    // act
    await new CredentialStore(path.join(server.stateRoot, 'config', 'credentials.json.enc'), false).set('qa:fake', { user: 'other', password: 'y' });
    await tls.readOk(server);

    // assert
    expect(checkDatasource).toHaveBeenCalledTimes(2);
    expect(checkDatasource.mock.calls[1][0].credentials).toStrictEqual({ user: 'other', password: 'y' });
  });
});
