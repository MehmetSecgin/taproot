import type { AppContext } from './app.js';
import { TaprootError } from './error-classification.js';
import { suggestNames } from './grpc-introspect.js';
import { describeResolutionFailure } from './resolve-datasource.js';
import { cachedSchemaCatalog, type QuerySlot } from './schema-refresh.js';
import type { SchemaCatalog } from '../store/schema-catalog.js';
import type { DatasourceProfile, TableContext } from '../types/core.js';

export interface SchemaRequest {
  datasource: string;
  tables: string[];
}

function describedTables(catalog: SchemaCatalog, requested: string[]): Record<string, TableContext> {
  const byLowerName = new Map(Object.keys(catalog.tables).map((table) => [table.toLowerCase(), table]));
  return Object.fromEntries(requested.map((name) => {
    const table = byLowerName.get(name.toLowerCase());
    if (table) return [table, catalog.tables[table]];
    const didYouMean = suggestNames(name, Object.keys(catalog.tables), 3);
    const hint = didYouMean.length ? ` Did you mean: ${didYouMean.join(', ')}?` : '';
    throw new TaprootError('UNKNOWN_TABLE', `table '${name}' doesn't exist in '${catalog.datasource}'.${hint}`, didYouMean.length ? { didYouMean } : undefined);
  }));
}

export function schemaDatasource(ctx: AppContext, name: string): DatasourceProfile {
  const datasource = ctx.datasourceStore.get(name);
  if (!datasource) throw new Error(describeResolutionFailure(ctx.datasourceStore.list(), { rawDs: name }));
  return datasource;
}

export async function readSchema(ctx: AppContext, datasource: DatasourceProfile, tables: string[], acquireQuerySlot: QuerySlot | undefined): Promise<{ tables: string[] | Record<string, TableContext> }> {
  const catalog = await cachedSchemaCatalog(ctx, datasource, acquireQuerySlot);
  return { tables: tables.length ? describedTables(catalog, tables) : Object.keys(catalog.tables) };
}
