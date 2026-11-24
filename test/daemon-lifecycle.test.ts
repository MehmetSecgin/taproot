import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RUNTIME_CONSTANTS } from '../src/core/constants.js';
import { remoteRpcCall, rpcCall } from '../src/daemon/client.js';
import type { DaemonInstance, DaemonListen } from '../src/daemon/server.js';
import { tlsPort } from './helpers/daemon.js';
import { createDeferred } from './helpers/deferred.js';
import { stubProcessExit } from './helpers/noop.js';
import { createTestPki } from './helpers/mutual-tls.js';
import { startQueryDaemon, stopQueryDaemons } from './helpers/query-daemon.js';

const READ = { datasource: 'qa-fake', query: 'SELECT 1 AS ok' };

function onUnixSocket(stateRoot: string): DaemonListen {
  return { kind: 'unix', socketPath: path.join(stateRoot, 'run', 'lifecycle.sock') };
}

function socketPathOf(daemon: DaemonInstance): string {
  if (!('socketPath' in daemon.endpoint)) {
    throw new Error('this daemon does not listen on a unix socket');
  }
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
  const pki = createTestPki();
  const overTls = (): DaemonListen => ({ kind: 'tls', host: '127.0.0.1', port: 0, tls: pki.daemon, reloadMs: 60_000 });

  async function readOverTls(daemon: DaemonInstance): ReturnType<typeof remoteRpcCall> {
    return remoteRpcCall({ server: { host: '127.0.0.1', port: tlsPort(daemon) }, tls: pki.client, method: 'query.execute', params: READ, timeoutMs: 5000 });
  }

  afterEach(async () => {
    await stopQueryDaemons();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('closes its plugins when it stops', async () => {
    // arrange
    const close = vi.fn<() => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const daemon = await startQueryDaemon(onUnixSocket, { close });

    // act
    await daemon.stop();

    // assert
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes the plugin sessions the sweep expires', async () => {
    // arrange
    freezeSweepClock();
    const closeSession = vi.fn<() => Promise<void>>(async () => {
      await Promise.resolve();
    });
    const daemon = await startQueryDaemon(overTls, { closeSession });
    const reply = await readOverTls(daemon);

    // act
    letPass(RUNTIME_CONSTANTS.session.idleTtlMs);

    // assert
    expect(closeSession).toHaveBeenCalledWith(reply.meta.sessionId);
  });

  it('exits the process after the idle limit on a unix socket', async () => {
    // arrange
    freezeSweepClock();
    const exit = stubProcessExit();
    await startQueryDaemon(onUnixSocket);

    // act
    letPass(RUNTIME_CONSTANTS.daemon.idleExitMs);

    // assert
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
  });

  it('keeps serving past the idle limit over TLS', async () => {
    // arrange
    freezeSweepClock();
    const exit = stubProcessExit();
    const daemon = await startQueryDaemon(overTls);

    // act
    letPass(RUNTIME_CONSTANTS.daemon.idleExitMs);
    const reply = await readOverTls(daemon);

    // assert
    expect(reply.ok).toBe(true);
    expect(exit).not.toHaveBeenCalled();
  });

  it('refuses a second daemon on the socket of one that serves no status method', async () => {
    // arrange
    const first = await startQueryDaemon(onUnixSocket);
    const socketPath = socketPathOf(first);

    // act
    const second = startQueryDaemon(() => ({ kind: 'unix', socketPath }));

    // assert
    await expect(second).rejects.toThrow('taprootd already running');
    const reply = await rpcCall({ socketPath, method: 'query.execute', params: READ });
    expect(reply.ok).toBe(true);
  });

  it('leaves the socket to a successor that binds while it still closes its plugins', async () => {
    // arrange
    const closeGate = createDeferred();
    const close = vi.fn<() => Promise<void>>(async () => closeGate.promise);
    const old = await startQueryDaemon(onUnixSocket, { close });
    const socketPath = socketPathOf(old);

    // act
    const stopping = old.stop();
    await vi.waitFor(() => {
      expect(close).toHaveBeenCalledWith();
    });
    await startQueryDaemon(() => ({ kind: 'unix', socketPath }));
    closeGate.resolve();
    await stopping;

    // assert
    const reply = await rpcCall({ socketPath, method: 'query.execute', params: READ });
    expect(reply.ok).toBe(true);
  });
});
