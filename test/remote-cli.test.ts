import { execFile } from 'node:child_process';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContext } from '../src/core/app.js';
import { DATASOURCE_COLUMNS } from '../src/core/datasource-list.js';
import { datasourceListMethod, schemaMethod } from '../src/daemon/handlers/catalog-methods.js';
import { queryMethod } from '../src/daemon/handlers/query-method.js';
import { startDaemon, type DaemonInstance } from '../src/daemon/server.js';
import { fakePlugin } from './helpers/fake-plugin.js';
import { createTestPki } from './helpers/mutual-tls.js';
import { restoreQueryEnv, setupQueryState } from './helpers/query-state.js';

const REMOTE_CLI = path.resolve(__dirname, 'helpers/remote-cli-main.ts');
let daemon: DaemonInstance;
let cliEnv: Record<string, string>;

beforeAll(async () => {
  const pki = createTestPki();
  await setupQueryState({ kind: 'mysql' });
  const plugin = fakePlugin({ kind: 'mysql', columns: ['table_name', 'column_name'], rows: [['orders', 'id']] });
  daemon = await startDaemon({
    ctx: buildContext({ kbDir: undefined, verbose: false, plugins: [plugin], useKeychain: false }),
    listen: { kind: 'tls', host: '127.0.0.1', port: 0, tls: pki.daemon, reloadMs: 60_000 },
    methods: [queryMethod(), datasourceListMethod({ columns: DATASOURCE_COLUMNS }), schemaMethod()],
    checkDatasource: undefined,
    log: () => undefined,
  });
  cliEnv = {
    TEST_DAEMON_HOST: '127.0.0.1',
    TEST_DAEMON_PORT: String((daemon.address as AddressInfo).port),
    TEST_TLS_CA: pki.client.caFile,
    TEST_TLS_CERT: pki.client.certFile,
    TEST_TLS_KEY: pki.client.keyFile,
  };
});

afterAll(async () => {
  await daemon.stop();
  restoreQueryEnv();
});

async function runRemoteCli(args: string[]): Promise<{ lines: string[]; json: Record<string, unknown> }> {
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', REMOTE_CLI, ...args], { env: { ...process.env, ...cliEnv } })
    .catch((error: { stdout: string }) => ({ stdout: error.stdout }));
  const lines = stdout.trim().split('\n');
  return { lines, json: JSON.parse(lines[0]) };
}

describe('a CLI built with the remote executor', () => {
  it('lists only the commands it was built with', async () => {
    // act
    const { json } = await runRemoteCli(['--help']);

    // assert
    const commands = (json.data as { commands: Array<{ name: string }> }).commands;
    expect(commands.map((command) => command.name.split(' ')[0])).toEqual(['datasource', 'schema', 'query', 'help']);
  });

  it.each([
    [['schema', '--table', 'orders'], "error: required option '--datasource <name>' not specified"],
    [['datasource', 'list', '--bogus'], "error: unknown option '--bogus'"],
    [['doctor'], "error: unknown command 'doctor'"],
  ])('answers %j with one line of JSON', async (args, message) => {
    // act
    const { lines, json } = await runRemoteCli(args);

    // assert
    expect(lines).toHaveLength(1);
    expect(json).toEqual({ ok: false, error: { code: 'CLI_ERROR', message } });
  });

  it('runs a query on the daemon', async () => {
    // act
    const { json } = await runRemoteCli(['query', '--datasource', 'qa-fake', '--sql', 'SELECT table_name FROM orders', '--pluck', 'data.rows']);

    // assert
    expect(json).toEqual([['orders', 'id']]);
  });

  it('lists the daemon datasources', async () => {
    // act
    const { json } = await runRemoteCli(['datasource', 'list', '--pluck', 'data.rows']);

    // assert
    expect(json).toEqual([['qa-fake', 'mysql', 'qa', 'fake', '127.0.0.1', 'fake']]);
  });

  it('reads table names from the daemon schema cache', async () => {
    // act
    const { json } = await runRemoteCli(['schema', '--datasource', 'qa-fake']);

    // assert
    expect(json).toEqual({ ok: true, data: { tables: ['orders'] } });
  });
});
