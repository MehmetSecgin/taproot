import type { AppContext } from './app.js';
import { connectorFailureSummary, runDatasourceConnectors } from './connector-runner.js';
import type { DatasourceProfile } from '../types/datasource.js';
import { connectivity } from './taproot-error.js';
import { rowObject } from './rows.js';
import type { CatalogRow, CatalogRows } from './schema-catalog-build.js';
import type { QuerySlot } from './schema-refresh.js';
import { catalogQueries } from './schema-catalog-sql.js';
import { DEFAULT_SESSION_TIME_ZONE } from './session-timezone.js';
import { withSessionId } from './session-credentials.js';

export type CatalogReadTarget = {
  ctx: AppContext;
  datasource: DatasourceProfile;
  sessionId: string | undefined;
  acquireQuerySlot: QuerySlot | undefined;
};

type CatalogReader = (sql: string) => Promise<CatalogRow[]>;

async function assertConnectorsPass({ ctx, datasource }: CatalogReadTarget): Promise<void> {
  const connectorChecks = await runDatasourceConnectors({
    datasource,
    credentialStore: ctx.credentialStore,
    pluginRegistry: ctx.pluginRegistry,
    mode: 'connect',
  });
  const failureSummary = connectorFailureSummary(connectorChecks);
  if (failureSummary !== undefined) {
    throw connectivity(`connector preflight failed: ${failureSummary}`);
  }
}

async function openCatalogReader(target: CatalogReadTarget, signal: AbortSignal): Promise<CatalogReader> {
  const { ctx, datasource, sessionId } = target;
  const execute = ctx.pluginRegistry.get(datasource.kind)?.execute;
  if (execute === undefined) {
    throw new Error(`no execute plugin for datasource kind '${datasource.kind}'`);
  }
  const credentials = await ctx.credentialStore.get(datasource.credentialRef);
  await assertConnectorsPass(target);
  const sessionCredentials = withSessionId(credentials, sessionId);
  return async (sql) => {
    const { result } = await execute(
      {
        datasource,
        query: sql,
        capability: 'executeRead',
        maxRows: undefined,
        sessionTimeZone: DEFAULT_SESSION_TIME_ZONE,
        signal,
      },
      sessionCredentials,
    );
    return result.rows.map((row) => rowObject(result.columns, row));
  };
}

export async function readCatalogRows(target: CatalogReadTarget, signal: AbortSignal): Promise<CatalogRows> {
  const releaseSlot = target.acquireQuerySlot === undefined ? undefined : await target.acquireQuerySlot(signal);
  try {
    const read = await openCatalogReader(target, signal);
    const queries = catalogQueries(target.datasource.connection.database ?? '');
    const columns = await read(queries.columns);
    const indexes = await read(queries.indexes);
    const partitions = await read(queries.partitions);
    return { columns, indexes, partitions };
  } finally {
    releaseSlot?.();
  }
}
