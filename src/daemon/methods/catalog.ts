import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { knownDatasourceColumns, listDatasources } from '../../core/datasource-list.js';
import type { DatasourceColumn } from '../../core/datasource-list.js';
import { readSchema, schemaDatasource } from '../../core/schema-read.js';
import type { DatasourceProfile } from '../../types/datasource.js';
import { RpcMethod } from '../types.js';
import { stringListParam, stringParam } from './rpc-params.js';
import type { DaemonMethod } from './types.js';

export function datasourceListMethod(options: { columns: readonly DatasourceColumn[]; filter?: (profile: DatasourceProfile) => boolean }): DaemonMethod {
  const columns = knownDatasourceColumns(options.columns);
  return {
    name: RpcMethod.DatasourceList,
    handle: async ({ req, base, deps }) => {
      base.ok = true;
      const request = { pattern: stringParam(req.params.pattern), detailed: req.params.detailed === true };
      base.data = listDatasources(deps.ctx, request, { columns, filter: options.filter });
    },
  };
}

export function schemaMethod(): DaemonMethod {
  return {
    name: RpcMethod.SchemaRead,
    handle: async ({ req, base, deps }) => {
      const datasource = schemaDatasource(deps.ctx, stringParam(req.params.datasource));
      await deps.admitDatasource(datasource, RUNTIME_CONSTANTS.query.catalogTimeoutMs);
      base.data = await readSchema(deps.ctx, {
        datasource,
        tables: stringListParam(req.params.tables),
        acquireQuerySlot: async (signal) => deps.queryLimiter.acquire(signal),
      });
      base.ok = true;
    },
  };
}
