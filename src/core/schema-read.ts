import type { AppContext } from './app.js';
import { TaprootError, badInput, connectivity } from './taproot-error.js';
import { suggestNames } from './name-match.js';
import { describeResolutionFailure } from './datasource-resolution-failure.js';
import { ensureDatasourceCatalog } from './schema-refresh.js';
import type { QuerySlot } from './schema-refresh.js';
import type { SchemaCatalog } from '../store/schema-catalog.js';
import { SQL_DATASOURCE_KINDS } from '../types/datasource.js';
import type { DatasourceProfile } from '../types/datasource.js';
import type { TableContext } from '../types/schema-context.js';

export type SchemaRequest = {
  datasource: string;
  tables: string[];
};

type TableDescription = Pick<TableContext, 'columns'> & Partial<Pick<TableContext, 'primaryKey' | 'indexes' | 'partition'>>;

type SchemaReadResult = { tables: string[] | Record<string, TableDescription> };

type SchemaReadInput = {
  datasource: DatasourceProfile;
  tables: string[];
  acquireQuerySlot: QuerySlot | undefined;
};

type CatalogMissRefresh = {
  ctx: AppContext;
  datasource: DatasourceProfile;
  acquireQuerySlot: QuerySlot | undefined;
  cached: SchemaCatalog;
};

const MAX_TABLE_SUGGESTIONS = 3;

function findTableIgnoringCase(catalog: SchemaCatalog, name: string): string | undefined {
  const lowerName = name.toLowerCase();
  return Object.keys(catalog.tables).find((table) => table.toLowerCase() === lowerName);
}

function tableDescription(table: TableContext): TableDescription {
  return {
    columns: table.columns,
    ...((table.primaryKey?.length ?? 0) > 0 ? { primaryKey: table.primaryKey } : {}),
    ...(table.indexes.length > 0 ? { indexes: table.indexes } : {}),
    ...(table.partition === undefined ? {} : { partition: table.partition }),
  };
}

function unknownTableError(catalog: SchemaCatalog, name: string): TaprootError {
  const didYouMean = suggestNames(name, Object.keys(catalog.tables), MAX_TABLE_SUGGESTIONS);
  const hint = didYouMean.length > 0 ? ` Did you mean: ${didYouMean.join(', ')}?` : '';
  return new TaprootError('UNKNOWN_TABLE', `table '${name}' doesn't exist in '${catalog.datasource}'.${hint}`, didYouMean.length > 0 ? { didYouMean } : undefined);
}

function describedTables(catalog: SchemaCatalog, requested: string[]): Record<string, TableDescription> {
  return Object.fromEntries(requested.map((name) => {
    const table = findTableIgnoringCase(catalog, name);
    if (table === undefined) {
      throw unknownTableError(catalog, name);
    }
    return [table, tableDescription(catalog.tables[table])];
  }));
}

export function schemaDatasource(ctx: AppContext, name: string): DatasourceProfile {
  const datasource = ctx.datasourceStore.get(name);
  if (datasource === undefined) {
    throw new Error(describeResolutionFailure(ctx.datasourceStore.list(), { datasourceName: name }));
  }
  return datasource;
}

async function catalogOnceRefreshed(ctx: AppContext, datasource: DatasourceProfile, refresh: ReturnType<typeof ensureDatasourceCatalog>): Promise<SchemaCatalog> {
  const { error } = await refresh;
  const fetched = ctx.schemaCatalogStore.get(datasource.name);
  if (fetched === undefined) {
    throw connectivity(`could not read the schema of '${datasource.name}': ${error}.`);
  }
  return fetched;
}

export async function cachedSchemaCatalog(ctx: AppContext, datasource: DatasourceProfile, acquireQuerySlot: QuerySlot | undefined): Promise<SchemaCatalog> {
  if (!SQL_DATASOURCE_KINDS.has(datasource.kind)) {
    throw badInput(`'${datasource.name}' is a ${datasource.kind} datasource; only SQL datasources have a schema.`);
  }
  const refresh = ensureDatasourceCatalog(ctx, datasource, { sessionId: undefined, acquireQuerySlot, afterSchemaError: false });
  return ctx.schemaCatalogStore.get(datasource.name) ?? (await catalogOnceRefreshed(ctx, datasource, refresh));
}

async function refreshedCatalogOrCached({ ctx, datasource, acquireQuerySlot, cached }: CatalogMissRefresh): Promise<SchemaCatalog> {
  await ensureDatasourceCatalog(ctx, datasource, { sessionId: undefined, acquireQuerySlot, afterSchemaError: true });
  return ctx.schemaCatalogStore.get(datasource.name) ?? cached;
}

export async function readSchema(ctx: AppContext, input: SchemaReadInput): Promise<SchemaReadResult> {
  const { datasource, tables, acquireQuerySlot } = input;
  const cached = await cachedSchemaCatalog(ctx, datasource, acquireQuerySlot);
  if (tables.length === 0) {
    return { tables: Object.keys(cached.tables) };
  }
  const allCached = tables.every((name) => findTableIgnoringCase(cached, name) !== undefined);
  const catalog = allCached ? cached : await refreshedCatalogOrCached({ ctx, datasource, acquireQuerySlot, cached });
  return { tables: describedTables(catalog, tables) };
}
