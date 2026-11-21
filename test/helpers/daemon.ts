import { buildContext } from '../../src/core/app.js';
import { DATASOURCE_COLUMNS } from '../../src/core/datasource-list.js';
import { datasourceListMethod, schemaMethod } from '../../src/daemon/handlers/catalog-methods.js';
import { statusMethod, stopMethod } from '../../src/daemon/handlers/daemon-status.js';
import { queryMethod } from '../../src/daemon/handlers/query-method.js';
import { startDaemon, type DaemonInstance } from '../../src/daemon/server.js';
import { builtinPlugins } from '../../src/plugins/load-builtins.js';
import type { TapRootPlugin } from '../../src/types/core.js';

export function startLocalDaemon(input: { stateRoot: string; socketPath: string; plugins: TapRootPlugin[] }): Promise<DaemonInstance> {
  process.env.TAPROOT_STATE_ROOT = input.stateRoot;
  return startDaemon({
    ctx: buildContext({ kbDir: undefined, verbose: false, plugins: [...builtinPlugins(), ...input.plugins], useKeychain: true }),
    listen: { kind: 'unix', socketPath: input.socketPath },
    methods: [statusMethod(), stopMethod(), queryMethod(), datasourceListMethod({ columns: DATASOURCE_COLUMNS }), schemaMethod()],
    checkDatasource: undefined,
    log: () => undefined,
  });
}
