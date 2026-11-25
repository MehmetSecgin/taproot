import { buildContext } from '../../src/core/app.js';
import { queryMethod } from '../../src/daemon/methods/query.js';
import { startDaemon } from '../../src/daemon/server.js';
import type { DaemonInstance, DaemonListen } from '../../src/daemon/server.js';
import type { TapRootPlugin } from '../../src/types/plugin.js';
import { fakePlugin } from './fake-plugin.js';
import { createNoop } from './noop.js';
import { restoreProcessEnv, setupQueryState } from './query-state.js';

const running: DaemonInstance[] = [];

export async function startQueryDaemon(listenFor: (stateRoot: string) => DaemonListen, pluginOverrides: Partial<TapRootPlugin> = {}): Promise<DaemonInstance> {
  const stateRoot = await setupQueryState();
  const daemon = await startDaemon({
    ctx: buildContext({ kbDir: undefined, verbose: false, plugins: [{ ...fakePlugin(), ...pluginOverrides }], useKeychain: false }),
    listen: listenFor(stateRoot),
    methods: [queryMethod()],
    checkDatasource: undefined,
    checkDatasourceTtlMs: undefined,
    log: createNoop(),
  });
  running.push(daemon);
  return daemon;
}

export async function stopQueryDaemons(): Promise<void> {
  for (const daemon of running.splice(0)) {
    await daemon.stop();
  }
  restoreProcessEnv();
}
