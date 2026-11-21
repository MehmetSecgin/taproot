import path from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildContext } from '../src/core/app.js';
import { RUNTIME_CONSTANTS } from '../src/core/constants.js';
import { remoteRpcCall, rpcCall } from '../src/daemon/client.js';
import { queryMethod } from '../src/daemon/methods/query.js';
import { startDaemon, type DaemonInstance, type DaemonListen } from '../src/daemon/server.js';
import type { TapRootPlugin } from '../src/types/core.js';
import { tlsPort } from './helpers/daemon.js';
import { fakePlugin } from './helpers/fake-plugin.js';
import { createTestPki, type TestPki } from './helpers/mutual-tls.js';
import { restoreQueryEnv, setupQueryState } from './helpers/query-state.js';

const READ = { datasource: 'qa-fake', query: 'SELECT 1 AS ok' };
let pki: TestPki;
const running: DaemonInstance[] = [];

beforeAll(() => {
  pki = createTestPki();
});

afterEach(async () => {
  for (const daemon of running.splice(0)) await daemon.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
  restoreQueryEnv();
});

const onUnixSocket = (stateRoot: string): DaemonListen => ({ kind: 'unix', socketPath: path.join(stateRoot, 'run', 'lifecycle.sock') });
const overTls = (): DaemonListen => ({ kind: 'tls', host: '127.0.0.1', port: 0, tls: pki.daemon, reloadMs: 60_000 });

async function queryDaemon(listenFor: (stateRoot: string) => DaemonListen, plugin: TapRootPlugin = fakePlugin()): Promise<DaemonInstance> {
  const stateRoot = await setupQueryState();
  const daemon = await startDaemon({
    ctx: buildContext({ kbDir: undefined, verbose: false, plugins: [plugin], useKeychain: false }),
    listen: listenFor(stateRoot),
    methods: [queryMethod()],
    checkDatasource: undefined,
    log: () => undefined,
  });
  running.push(daemon);
  return daemon;
}

function readOverTls(daemon: DaemonInstance) {
  return remoteRpcCall({ server: { host: '127.0.0.1', port: tlsPort(daemon) }, tls: pki.client, method: 'query.execute', params: READ, timeoutMs: 5_000 });
}

function socketPathOf(daemon: DaemonInstance): string {
  if (!('socketPath' in daemon.endpoint)) throw new Error('this daemon does not listen on a unix socket');
  return daemon.endpoint.socketPath;
}

function freezeSweepClock(): void {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
}

function letPass(elapsedMs: number): void {
  vi.setSystemTime(Date.now() + elapsedMs);
  vi.advanceTimersByTime(RUNTIME_CONSTANTS.sweeper.tickMs);
}

describe('daemon lifecycle', () => {
  it('closes its plugins when it stops', async () => {
    // arrange
    const close = vi.fn(async () => undefined);
    const daemon = await queryDaemon(onUnixSocket, { ...fakePlugin(), close });

    // act
    await daemon.stop();

    // assert
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('closes the plugin sessions the sweep expires', async () => {
    // arrange
    freezeSweepClock();
    const closeSession = vi.fn(async () => undefined);
    const daemon = await queryDaemon(overTls, { ...fakePlugin(), closeSession });
    const reply = await readOverTls(daemon);

    // act
    letPass(RUNTIME_CONSTANTS.session.idleTtlMs);

    // assert
    expect(closeSession).toHaveBeenCalledWith(reply.meta.sessionId);
  });

  it('exits the process after the idle limit on a unix socket', async () => {
    // arrange
    freezeSweepClock();
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    await queryDaemon(onUnixSocket);

    // act
    letPass(RUNTIME_CONSTANTS.daemon.idleExitMs);

    // assert
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
  });

  it('keeps serving past the idle limit over TLS', async () => {
    // arrange
    freezeSweepClock();
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    const daemon = await queryDaemon(overTls);

    // act
    letPass(RUNTIME_CONSTANTS.daemon.idleExitMs);
    const reply = await readOverTls(daemon);

    // assert
    expect(reply.ok).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });

  it('refuses a second daemon on the socket of one that serves no status method', async () => {
    // arrange
    const first = await queryDaemon(onUnixSocket);
    const socketPath = socketPathOf(first);

    // act
    const second = queryDaemon(() => ({ kind: 'unix', socketPath }));

    // assert
    await expect(second).rejects.toThrow('taprootd already running');
    expect((await rpcCall({ socketPath, method: 'query.execute', params: READ })).ok).toBe(true);
  });
});
