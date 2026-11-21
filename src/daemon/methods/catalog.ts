import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { knownDatasourceColumns, listDatasources, type DatasourceColumn } from '../../core/datasource-list.js';
import { readSchema, schemaDatasource } from '../../core/schema-read.js';
import type { DatasourceProfile } from '../../types/core.js';
import { RpcMethod } from '../types.js';
import { stringListParam, stringParam } from './rpc-params.js';
import type { DaemonMethod } from './types.js';

export function datasourceListMethod(options: { columns: readonly DatasourceColumn[]; filter?: (profile: DatasourceProfile) => boolean }): DaemonMethod {
  const columns = knownDatasourceColumns(options.columns);
  return {
    name: RpcMethod.DatasourceList,
    handle: async ({ req, base, deps }) => {
      base.ok = true;
      base.data = listDatasources(deps.ctx, { pattern: stringParam(req.params.pattern), detailed: req.params.detailed === true }, columns, options.filter);
    },
  };
}

export function schemaMethod(): DaemonMethod {
  return {
    name: RpcMethod.SchemaRead,
    handle: async ({ req, base, deps }) => {
      const datasource = schemaDatasource(deps.ctx, stringParam(req.params.datasource));
      await deps.admitDatasource(datasource, RUNTIME_CONSTANTS.query.catalogTimeoutMs);
      base.data = await readSchema(deps.ctx, datasource, stringListParam(req.params.tables), (signal) => deps.queryLimiter.acquire({ signal }));
      base.ok = true;
    },
  };
}
