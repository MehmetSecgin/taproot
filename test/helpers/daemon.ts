import { buildContext } from '../../src/core/app.js';
import { DATASOURCE_COLUMNS } from '../../src/core/datasource-list.js';
import { datasourceListMethod, schemaMethod } from '../../src/daemon/methods/catalog.js';
import { statusMethod, stopMethod } from '../../src/daemon/methods/status.js';
import { queryMethod } from '../../src/daemon/methods/query.js';
import { startDaemon, type DaemonInstance } from '../../src/daemon/server.js';
import { builtinPlugins } from '../../src/plugins-builtins/index.js';
import type { TapRootPlugin } from '../../src/types/core.js';

export function startLocalDaemon(input: { stateRoot: string; socketPath: string; plugins: TapRootPlugin[] }): Promise<DaemonInstance> {
  process.env.TAPROOT_STATE_ROOT = input.stateRoot;
  return startDaemon({
    ctx: buildContext({ kbDir: undefined, verbose: false, plugins: [...builtinPlugins(), ...input.plugins], useKeychain: true }),
    listen: { kind: 'unix', socketPath: input.socketPath },
    methods: [statusMethod(), stopMethod(), queryMethod(), datasourceListMethod({ columns: DATASOURCE_COLUMNS, filter: undefined }), schemaMethod()],
    checkDatasource: undefined,
    checkDatasourceTtlMs: undefined,
    log: () => undefined,
  });
}

export function tlsPort(daemon: DaemonInstance): number {
  if (!('port' in daemon.endpoint)) throw new Error('this daemon does not listen on TLS');
  return daemon.endpoint.port;
}
