import { afterEach } from 'vitest';
import { remoteRpcCall } from '../../src/daemon/client.js';
import type { HostPort, MutualTlsFiles } from '../../src/daemon/transport.js';
import type { DatasourceProfile } from '../../src/types/datasource.js';
import type { TapRootPlugin } from '../../src/types/plugin.js';
import { tlsPort } from './daemon.js';
import { fakePlugin } from './fake-plugin.js';
import { createTestPki } from './mutual-tls.js';
import type { TestPki } from './mutual-tls.js';
import { startTlsDaemon } from './tls-daemon.js';
import type { TlsDaemonOptions } from './tls-daemon.js';
import { restoreProcessEnv, setupQueryState } from './query-state.js';

export type TlsDaemonInput = Partial<Omit<TlsDaemonOptions, 'plugins' | 'tls'>> & {
  files?: MutualTlsFiles;
  plugin?: TapRootPlugin;
  profile?: Partial<DatasourceProfile>;
};

const CALL_TIMEOUT_MS = 5000;

export type StartedTlsDaemon = HostPort & { stateRoot: string };

export type TlsDaemons = {
  pki: TestPki;
  otherPki: TestPki;
  startDaemon: (input?: TlsDaemonInput) => Promise<StartedTlsDaemon>;
  call: (server: HostPort, method: string, params: Record<string, unknown>) => ReturnType<typeof remoteRpcCall>;
  readOk: (server: HostPort, files?: MutualTlsFiles) => ReturnType<typeof remoteRpcCall>;
  readSucceeds: (server: HostPort, files: MutualTlsFiles) => Promise<boolean>;
};

export function recordEvents(): { events: Record<string, unknown>[]; log: NonNullable<TlsDaemonOptions['log']> } {
  const events: Record<string, unknown>[] = [];
  return {
    events,
    log: (event) => {
      events.push(event);
    },
  };
}

export function useTlsDaemons(): TlsDaemons {
  const pki = createTestPki();
  const otherPki = createTestPki();
  const running: (() => Promise<void>)[] = [];

  afterEach(async () => {
    for (const stop of running.splice(0)) {
      await stop();
    }
    restoreProcessEnv();
  });

  const startTestDaemon = async (input: TlsDaemonInput = {}): Promise<StartedTlsDaemon> => {
    const { files, plugin, profile, ...options } = input;
    const stateRoot = await setupQueryState(profile);
    const daemon = await startTlsDaemon({ checkDatasource: undefined, ...options, plugins: [plugin ?? fakePlugin()], tls: files ?? pki.daemon });
    running.push(daemon.stop);
    return { host: '127.0.0.1', port: tlsPort(daemon), stateRoot };
  };
  const readOk: TlsDaemons['readOk'] = async (server, files = pki.client) =>
    remoteRpcCall({ server, tls: files, method: 'query.execute', params: { datasource: 'qa-fake', query: 'SELECT 1 AS ok' }, timeoutMs: CALL_TIMEOUT_MS });
  return {
    pki,
    otherPki,
    startDaemon: startTestDaemon,
    call: async (server, method, params) => remoteRpcCall({ server, tls: pki.client, method, params, timeoutMs: CALL_TIMEOUT_MS }),
    readOk,
    readSucceeds: async (server, files) => {
      try {
        const reply = await readOk(server, files);
        return reply.ok;
      } catch {
        return false;
      }
    },
  };
}
