import type { AppContext } from '../core/app.js';
import type { DatasourceProfile } from '../types/datasource.js';

export function requireDatasource(ctx: AppContext, name: string): DatasourceProfile {
  const datasource = ctx.datasourceStore.get(name);
  if (!datasource) {
    throw new Error(`Datasource not found: ${name}`);
  }
  return datasource;
}
