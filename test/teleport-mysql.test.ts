import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import mysql from 'mysql2';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { closeAllMysqlPools } from '../src/plugins-builtins/_shared/mysql-connection-lease.js';
import { teleportMysqlPlugin } from '../src/plugins-builtins/teleport-mysql/index.js';
import { closeTeleportMysqlSessionProxies } from '../src/plugins-builtins/teleport-mysql/proxy-pool.js';
import { column, startFakeMysqlServer } from './helpers/fake-mysql-server.js';
import { answerWithoutError, executeOf, profilesDatasource, startServerForTest } from './helpers/mysql-row-cap-support.js';

function stubForwardingTsh(upstreamPort: number): { pathEnv: string; proxyPids: () => number[] } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-tsh-forward-'));
  const pids = path.join(binDir, 'pids');
  const forwarder = path.join(binDir, 'forward.mjs');
  fs.writeFileSync(
    forwarder,
    [
      "import net from 'node:net';",
      "const port = Number(process.argv[process.argv.indexOf('--port') + 1]);",
      'net.createServer((client) => {',
      `  const upstream = net.connect(${upstreamPort}, '127.0.0.1');`,
      "  client.on('error', () => upstream.destroy());",
      "  upstream.on('error', () => client.destroy());",
      '  client.pipe(upstream).pipe(client);',
      "}).listen(port, '127.0.0.1');",
    ].join('\n'),
  );
  const script = path.join(binDir, 'tsh');
  fs.writeFileSync(script, `#!/bin/sh\necho $$ >> '${pids}'\nexec '${process.execPath}' '${forwarder}' "$@"\n`);
  fs.chmodSync(script, 0o755);
  return {
    pathEnv: `${binDir}:${process.env.PATH}`,
    proxyPids: () => (fs.existsSync(pids) ? fs.readFileSync(pids, 'utf8').trim().split('\n').map(Number) : []),
  };
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntilReaped(pid: number): Promise<void> {
  while (isRunning(pid)) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 20);
    });
  }
}

describe('teleport mysql proxy reuse', () => {
  const sessionId = 'proxy-exit-session';

  it('starts a fresh proxy when the previous one exited on its own', async () => {
    // arrange
    onTestFinished(async () => {
      await closeTeleportMysqlSessionProxies(sessionId);
      await closeAllMysqlPools();
      vi.unstubAllEnvs();
    });
    const server = await startServerForTest(async () =>
      startFakeMysqlServer(() => ({ columns: [column('profiles', 'ok', mysql.Types.LONG)], row: ['1'] }), answerWithoutError),
    );
    const tsh = stubForwardingTsh(server.port);
    vi.stubEnv('PATH', tsh.pathEnv);
    const request = {
      datasource: profilesDatasource('teleport-mysql', { target: 'profiles-db', database: 'profiles' }),
      query: 'SELECT 1 AS ok',
      capability: 'executeRead' as const,
      sessionTimeZone: '+00:00',
      signal: undefined,
    };
    const creds = { dbUser: 'reader', password: '', __sessionId: sessionId };
    await executeOf(teleportMysqlPlugin)(request, creds);
    const [firstProxy] = tsh.proxyPids();
    process.kill(firstProxy, 'SIGTERM');
    await waitUntilReaped(firstProxy);

    // act
    const result = await executeOf(teleportMysqlPlugin)(request, creds);

    // assert
    expect(result.result.rows).toStrictEqual([[1]]);
    expect(tsh.proxyPids()).toHaveLength(2);
  });
});
