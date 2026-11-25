import { describe, expect, it } from 'vitest';
import { datasourceListMethod } from '../src/daemon/methods/catalog.js';
import { fakePlugin } from './helpers/fake-plugin.js';
import { useTlsDaemons } from './helpers/tls-daemon-fixture.js';
import type { StartedTlsDaemon } from './helpers/tls-daemon-fixture.js';

function buildListMethodWithUnknownColumn(): void {
  Reflect.apply(datasourceListMethod, undefined, [{ columns: ['name', 'password'] }]);
}

describe('daemon schema and table methods', () => {
  const tls = useTlsDaemons();

  const catalogDaemon = async (): Promise<StartedTlsDaemon> => tls.startDaemon({
    plugin: fakePlugin({ kind: 'mysql', columns: ['table_name', 'column_name'], rows: [['orders', 'id'], ['orders', 'note']] }),
    profile: { kind: 'mysql' },
  });

  it('lists the datasources with the same columns as the CLI listing', async () => {
    // arrange
    const server = await tls.startDaemon();

    // act
    const res = await tls.call(server, 'datasource.list', {});

    // assert
    expect(res.data).toStrictEqual({
      columns: ['name', 'kind', 'env', 'service', 'host', 'database'],
      rows: [['qa-fake', 'fake', 'qa', 'fake', '127.0.0.1', 'fake']],
    });
  });

  it('lists only the profiles its filter keeps', async () => {
    // arrange
    const server = await tls.startDaemon({ listFilter: (profile) => profile.kind === 'mysql' });

    // act
    const res = await tls.call(server, 'datasource.list', {});

    // assert
    expect(res.data).toStrictEqual({ columns: [], rows: [] });
  });

  it('lists only the columns the daemon serves', async () => {
    // arrange
    const server = await tls.startDaemon({ listColumns: ['name', 'kind'] });

    // act
    const res = await tls.call(server, 'datasource.list', { detailed: true });

    // assert
    expect(res.data).toStrictEqual({ columns: ['name', 'kind'], rows: [['qa-fake', 'fake']] });
  });

  it('adds the detailed columns it serves only when the client asks', async () => {
    // arrange
    const server = await tls.startDaemon({ listColumns: ['name', 'updatedAt'] });

    // act
    const plain = await tls.call(server, 'datasource.list', {});
    const detailed = await tls.call(server, 'datasource.list', { detailed: true });

    // assert
    expect(plain.data).toStrictEqual({ columns: ['name'], rows: [['qa-fake']] });
    expect(detailed.data).toStrictEqual({ columns: ['name', 'updatedAt'], rows: [['qa-fake', expect.any(String)]] });
  });

  it('refuses a column it does not know', () => {
    // assert
    expect(buildListMethodWithUnknownColumn).toThrow('unknown datasource columns: password');
  });

  it('lists the table names of a datasource', async () => {
    // arrange
    const server = await catalogDaemon();

    // act
    const res = await tls.call(server, 'schema.read', { datasource: 'qa-fake' });

    // assert
    expect(res.data).toStrictEqual({ tables: ['orders'] });
  });

  it('describes the tables asked for, whatever their case', async () => {
    // arrange
    const server = await catalogDaemon();

    // act
    const res = await tls.call(server, 'schema.read', { datasource: 'qa-fake', tables: ['ORDERS'] });

    // assert
    expect(res.data).toStrictEqual({ tables: { orders: { columns: ['id', 'note'] } } });
  });

  it('suggests close names for a table the datasource does not have', async () => {
    // arrange
    const server = await catalogDaemon();

    // act
    const res = await tls.call(server, 'schema.read', { datasource: 'qa-fake', tables: ['ordrs'] });

    // assert
    expect(res.error).toMatchObject({ code: 'UNKNOWN_TABLE', details: { didYouMean: ['orders'] } });
  });

  it('names the datasource it does not know', async () => {
    // arrange
    const server = await catalogDaemon();

    // act
    const res = await tls.call(server, 'schema.read', { datasource: 'qa-nope' });

    // assert
    expect(res.error?.code).toBe('UNKNOWN_DATASOURCE');
  });
});
