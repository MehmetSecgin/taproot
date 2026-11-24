import { buildContext } from '../../src/core/app.js';
import { DATASOURCE_COLUMNS } from '../../src/core/datasource-list.js';
import type { DatasourceColumn } from '../../src/core/datasource-list.js';
import type { DatasourceCheck } from '../../src/daemon/datasource-check.js';
import { datasourceListMethod, schemaMethod } from '../../src/daemon/methods/catalog.js';
import { queryMethod } from '../../src/daemon/methods/query.js';
import type { QueryMethodOptions } from '../../src/daemon/methods/query.js';
import { startDaemon } from '../../src/daemon/server.js';
import type { DaemonInstance, DaemonLog } from '../../src/daemon/server.js';
import type { MutualTlsFiles } from '../../src/daemon/transport.js';
import type { DatasourceProfile } from '../../src/types/datasource.js';
import type { TapRootPlugin } from '../../src/types/plugin.js';
import { createNoop } from './noop.js';

export type TlsDaemonOptions = {
  plugins: TapRootPlugin[];
  tls: MutualTlsFiles;
  checkDatasource: DatasourceCheck | undefined;
  checkDatasourceTtlMs?: number;
  query?: QueryMethodOptions;
  listColumns?: DatasourceColumn[];
  listFilter?: (profile: DatasourceProfile) => boolean;
  reloadMs?: number;
  log?: DaemonLog;
};

export async function startTlsDaemon(options: TlsDaemonOptions): Promise<DaemonInstance> {
  return startDaemon({
    ctx: buildContext({ kbDir: undefined, verbose: false, plugins: options.plugins, useKeychain: false }),
    listen: { kind: 'tls', host: '127.0.0.1', port: 0, tls: options.tls, reloadMs: options.reloadMs ?? 60_000 },
    methods: [queryMethod(options.query), datasourceListMethod({ columns: options.listColumns ?? DATASOURCE_COLUMNS, filter: options.listFilter }), schemaMethod()],
    checkDatasource: options.checkDatasource,
    checkDatasourceTtlMs: options.checkDatasourceTtlMs,
    log: options.log ?? createNoop(),
  });
}
