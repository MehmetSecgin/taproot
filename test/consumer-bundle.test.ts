import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { build } from 'tsup';
import { describe, expect, it } from 'vitest';

const DIST = path.resolve(import.meta.dirname, '../dist');
const ABSENT_FROM_DAEMON_BUNDLE = ['child_process', '/bin/sh', 'runShellCommand', 'discoverKubernetesTargets', 'fetchTshDatabases', 'spawnDaemon'];

const BUNDLE_TIMEOUT_MS = 30_000;

async function buildDaemonBundle(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-consumer-'));
  const entry = path.join(dir, 'daemon-entry.mjs');
  fs.writeFileSync(entry, [
    `import { buildContext } from '${DIST}/core.js';`,
    `import { DATASOURCE_COLUMNS, datasourceListMethod, queryMethod, schemaMethod, startDaemon } from '${DIST}/daemon.js';`,
    `import { mysqlPlugin } from '${DIST}/plugins/mysql.js';`,
    'const ctx = buildContext({ plugins: [mysqlPlugin], useKeychain: false });',
    "await startDaemon({ ctx, listen: { kind: 'tls', host: '127.0.0.1', port: 0, tls: { caFile: 'ca', certFile: 'crt', keyFile: 'key' }, reloadMs: 1000 }, methods: [queryMethod(), datasourceListMethod({ columns: DATASOURCE_COLUMNS, filter: undefined }), schemaMethod()], checkDatasource: undefined, checkDatasourceTtlMs: undefined, log: console.log });",
  ].join('\n'));
  await build({ entry: [entry], outDir: path.join(dir, 'out'), format: 'esm', platform: 'node', target: 'node20', config: false, silent: true, dts: false, splitting: false, external: ['keytar'] });
  return fs.readFileSync(path.join(dir, 'out', 'daemon-entry.js'), 'utf8');
}

describe('a daemon built from the mysql plugin alone', () => {
  const bundleReady = buildDaemonBundle();

  it('produces a daemon bundle that contains the daemon', async () => {
    // arrange
    const bundle = await bundleReady;

    // assert
    expect(bundle).toContain('function startDaemon');
  }, BUNDLE_TIMEOUT_MS);

  it.each(ABSENT_FROM_DAEMON_BUNDLE)('leaves %s out of the daemon bundle', async (needle) => {
    // arrange
    const bundle = await bundleReady;

    // assert
    expect(bundle).not.toContain(needle);
  }, BUNDLE_TIMEOUT_MS);
});
