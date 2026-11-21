import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildContext } from '../src/core/app.js';
import { DATASOURCE_COLUMNS } from '../src/core/datasource-list.js';
import { datasourceListMethod, schemaMethod } from '../src/daemon/methods/catalog.js';
import { queryMethod } from '../src/daemon/methods/query.js';
import { startDaemon, type DaemonInstance } from '../src/daemon/server.js';
import { DatasourceStore } from '../src/store/datasources.js';
import { tlsPort } from './helpers/daemon.js';
import { fakePlugin } from './helpers/fake-plugin.js';
import { createTestPki } from './helpers/mutual-tls.js';
import { restoreQueryEnv, setupQueryState } from './helpers/query-state.js';

const REMOTE_CLI = path.resolve(__dirname, 'helpers/remote-cli-main.ts');
let daemon: DaemonInstance;
let cliEnv: Record<string, string>;

beforeAll(async () => {
  const pki = createTestPki();
  const stateRoot = await setupQueryState({ kind: 'mysql' });
  const datasources = new DatasourceStore(path.join(stateRoot, 'config', 'datasources.json'));
  datasources.save({ ...datasources.get('qa-fake')!, name: 'qa-closed' });
  const plugin = fakePlugin({ kind: 'mysql', columns: ['table_name', 'column_name'], rows: [['orders', 'id']] });
  daemon = await startDaemon({
    ctx: buildContext({ kbDir: undefined, verbose: false, plugins: [plugin], useKeychain: false }),
    listen: { kind: 'tls', host: '127.0.0.1', port: 0, tls: pki.daemon, reloadMs: 60_000 },
    methods: [queryMethod(), datasourceListMethod({ columns: DATASOURCE_COLUMNS }), schemaMethod()],
    checkDatasource: async ({ datasource }) => {
      if (datasource.name === 'qa-closed') throw new Error("'qa-closed' is not served here.");
    },
    log: () => undefined,
  });
  cliEnv = {
    TEST_DAEMON_HOST: '127.0.0.1',
    TEST_DAEMON_PORT: String(tlsPort(daemon)),
    TEST_TLS_CA: pki.client.caFile,
    TEST_TLS_CERT: pki.client.certFile,
    TEST_TLS_KEY: pki.client.keyFile,
  };
});

afterAll(async () => {
  await daemon.stop();
  restoreQueryEnv();
});

async function runRemoteCli(args: string[]): Promise<{ lines: string[]; json: Record<string, unknown>; exitCode: number }> {
  const { stdout, exitCode } = await promisify(execFile)(process.execPath, ['--import', 'tsx', REMOTE_CLI, ...args], { env: { ...process.env, ...cliEnv } })
    .then((done) => ({ stdout: done.stdout, exitCode: 0 }), (error: { stdout: string; code: number }) => ({ stdout: error.stdout, exitCode: error.code }));
  const lines = stdout.trim().split('\n');
  return { lines, json: JSON.parse(lines[0]), exitCode };
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
    const { json } = await runRemoteCli(['datasource', 'list', 'fake', '--pluck', 'data.rows']);

    // assert
    expect(json).toEqual([['qa-fake', 'mysql', 'qa', 'fake', '127.0.0.1', 'fake']]);
  });

  it('exits 5 with the refusal alone for a datasource the daemon refuses', async () => {
    // act
    const { json, exitCode } = await runRemoteCli(['schema', '--datasource', 'qa-closed']);

    // assert
    expect(json).toEqual({ ok: false, error: { code: 'DATASOURCE_REFUSED', message: "DATASOURCE_REFUSED: 'qa-closed' is not served here." } });
    expect(exitCode).toBe(5);
  });

  it('names itself in the query help', async () => {
    // act
    const { json } = await runRemoteCli(['query', '--help']);

    // assert
    const help = JSON.stringify(json);
    expect(help).toContain('Example: remote query --datasource');
    expect(help).not.toContain('taproot query');
  });

  it('reads table names from the daemon schema cache', async () => {
    // act
    const { json } = await runRemoteCli(['schema', '--datasource', 'qa-fake']);

    // assert
    expect(json).toEqual({ ok: true, data: { tables: ['orders'] } });
  });
});
