import type { AppContext } from './app.js';
import { enforceConfinedTables } from './database-confinement.js';
import { TaprootError } from './error-classification.js';
import { suggestNames } from './grpc-introspect.js';
import { describeResolutionFailure } from './resolve-datasource.js';
import { cachedSchemaCatalog, ensureDatasourceCatalog, type QuerySlot } from './schema-refresh.js';
import type { SchemaCatalog } from '../store/schema-catalog.js';
import type { DatasourceProfile, TableContext } from '../types/core.js';

export interface SchemaRequest {
  datasource: string;
  tables: string[];
}

type TableDescription = Pick<TableContext, 'columns'> & Partial<Pick<TableContext, 'primaryKey' | 'indexes' | 'partition'>>;

function tableNamed(catalog: SchemaCatalog, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  return Object.keys(catalog.tables).find((table) => table.toLowerCase() === lowerName);
}

function tableDescription(table: TableContext): TableDescription {
  return {
    columns: table.columns,
    ...(table.primaryKey?.length ? { primaryKey: table.primaryKey } : {}),
    ...(table.indexes.length ? { indexes: table.indexes } : {}),
    ...(table.partition ? { partition: table.partition } : {}),
  };
}

function describedTables(catalog: SchemaCatalog, requested: string[]): Record<string, TableDescription> {
  return Object.fromEntries(requested.map((name) => {
    const table = tableNamed(catalog, name);
    if (table) return [table, tableDescription(catalog.tables[table])];
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

async function catalogAfterMiss(ctx: AppContext, datasource: DatasourceProfile, acquireQuerySlot: QuerySlot | undefined, cached: SchemaCatalog): Promise<SchemaCatalog> {
  await ensureDatasourceCatalog(ctx, datasource, { sessionId: undefined, acquireQuerySlot, afterSchemaError: true });
  return ctx.schemaCatalogStore.get(datasource.name) ?? cached;
}

export async function readSchema(ctx: AppContext, datasource: DatasourceProfile, tables: string[], acquireQuerySlot: QuerySlot | undefined): Promise<{ tables: string[] | Record<string, TableDescription> }> {
  enforceConfinedTables(datasource, tables);
  const cached = await cachedSchemaCatalog(ctx, datasource, acquireQuerySlot);
  if (!tables.length) return { tables: Object.keys(cached.tables) };
  const allCached = tables.every((name) => tableNamed(cached, name));
  const catalog = allCached ? cached : await catalogAfterMiss(ctx, datasource, acquireQuerySlot, cached);
  return { tables: describedTables(catalog, tables) };
}
