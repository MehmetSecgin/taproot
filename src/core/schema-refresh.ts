import type { AppContext } from './app.js';
import { runDatasourceConnectors } from './app.js';
import type { DatasourceProfile, QueryResult, SchemaProvenance } from '../types/core.js';

export interface RefreshedSchemaTable {
  table: string;
  columns: string[];
}

export interface RefreshedSchemaJoin {
  leftTable: string;
  rightTable: string;
  conditionRaw: string;
  conditionNormalized: string;
  directionHint: 'left-to-right' | 'right-to-left' | 'unknown';
}

export interface SchemaRefreshResult {
  datasource: string;
  database: string;
  tables: RefreshedSchemaTable[];
  joins: RefreshedSchemaJoin[];
  source: SchemaProvenance;
}

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function isSqlDatasource(kind: string): boolean {
  return ['mysql', 'postgres', 'teleport-mysql'].includes(String(kind || '').trim());
}

function tableSql(datasource: DatasourceProfile): string {
  const database = escapeSqlString(String(datasource.connection.database || ''));
  if (datasource.kind === 'postgres') {
    return [
      'SELECT table_name AS table_name, column_name AS column_name',
      'FROM information_schema.columns',
      `WHERE table_catalog = '${database}'`,
      "  AND table_schema NOT IN ('information_schema', 'pg_catalog')",
      'ORDER BY table_name, ordinal_position',
    ].join(' ');
  }
  return [
    'SELECT table_name AS table_name, column_name AS column_name',
    'FROM information_schema.columns',
    `WHERE table_schema = '${database}'`,
    'ORDER BY table_name, ordinal_position',
  ].join(' ');
}

function joinSql(datasource: DatasourceProfile): string {
  const database = escapeSqlString(String(datasource.connection.database || ''));
  if (datasource.kind === 'postgres') {
    return [
      'SELECT',
      '  tc.table_name AS left_table,',
      '  ccu.table_name AS right_table,',
      "  CONCAT(kcu.column_name, ' = ', ccu.column_name) AS condition_raw,",
      "  CONCAT(kcu.column_name, ' = ', ccu.column_name) AS condition_normalized",
      'FROM information_schema.table_constraints tc',
      'JOIN information_schema.key_column_usage kcu',
      '  ON tc.constraint_name = kcu.constraint_name',
      ' AND tc.table_schema = kcu.table_schema',
      'JOIN information_schema.constraint_column_usage ccu',
      '  ON ccu.constraint_name = tc.constraint_name',
      ' AND ccu.table_schema = tc.table_schema',
      "WHERE tc.constraint_type = 'FOREIGN KEY'",
      `  AND tc.table_catalog = '${database}'`,
      "  AND tc.table_schema NOT IN ('information_schema', 'pg_catalog')",
      'ORDER BY tc.table_name, ccu.table_name, kcu.ordinal_position',
    ].join(' ');
  }
  return [
    'SELECT',
    '  table_name AS left_table,',
    '  referenced_table_name AS right_table,',
    "  CONCAT(column_name, ' = ', referenced_column_name) AS condition_raw,",
    "  CONCAT(column_name, ' = ', referenced_column_name) AS condition_normalized",
    'FROM information_schema.key_column_usage',
    `WHERE table_schema = '${database}'`,
    '  AND referenced_table_name IS NOT NULL',
    'ORDER BY table_name, referenced_table_name, ordinal_position',
  ].join(' ');
}

async function executeRead(ctx: AppContext, datasource: DatasourceProfile, sql: string): Promise<QueryResult> {
  if (!isSqlDatasource(datasource.kind)) {
    throw new Error(`learning_unsupported: datasource kind '${datasource.kind}' does not support schema refresh`);
  }
  const plugin = ctx.pluginRegistry.get(datasource.kind);
  if (!plugin?.execute) throw new Error(`learning_unsupported: no execute plugin for datasource kind '${datasource.kind}'`);
  const creds = await ctx.credentialStore.get(datasource.credentialRef);
  const connectorChecks = await runDatasourceConnectors({
    datasource,
    credentialStore: ctx.credentialStore,
    pluginRegistry: ctx.pluginRegistry,
    mode: 'connect',
  });
  if (connectorChecks.some((c) => c.status === 'fail')) {
    throw new Error(`CONNECTIVITY: connector preflight failed: ${connectorChecks.filter((c) => c.status === 'fail').map((c) => c.detail).join(' | ')}`);
  }
  return plugin.execute(
    {
      datasource,
      query: sql,
      capability: 'executeRead',
    },
    creds,
  );
}

export async function refreshSchemaForDatasource(ctx: AppContext, datasource: DatasourceProfile): Promise<SchemaRefreshResult> {
  if (!isSqlDatasource(datasource.kind)) {
    throw new Error(`learning_unsupported: datasource kind '${datasource.kind}' does not support schema refresh`);
  }
  const tableResult = await executeRead(ctx, datasource, tableSql(datasource));
  const joinResult = await executeRead(ctx, datasource, joinSql(datasource));

  const tables = new Map<string, Set<string>>();
  for (const row of tableResult.result.rows) {
    const table = String(row.table_name || '').trim();
    const column = String(row.column_name || '').trim();
    if (!table) continue;
    const set = tables.get(table) || new Set<string>();
    if (column) set.add(column);
    tables.set(table, set);
  }

  const joins: RefreshedSchemaJoin[] = [];
  for (const row of joinResult.result.rows) {
    const leftTable = String(row.left_table || '').trim();
    const rightTable = String(row.right_table || '').trim();
    if (!leftTable || !rightTable) continue;
    const conditionRaw = String(row.condition_raw || '').trim() || `${leftTable} -> ${rightTable}`;
    const conditionNormalized = String(row.condition_normalized || '').trim() || conditionRaw.toLowerCase();
    joins.push({
      leftTable,
      rightTable,
      conditionRaw,
      conditionNormalized,
      directionHint: 'left-to-right',
    });
  }

  const refreshed: SchemaRefreshResult = {
    datasource: datasource.name,
    database: String(datasource.connection.database || ''),
    tables: [...tables.entries()]
      .map(([table, columns]) => ({ table, columns: [...columns].sort((a, b) => a.localeCompare(b)) }))
      .sort((a, b) => a.table.localeCompare(b.table)),
    joins: joins.sort((a, b) => `${a.leftTable}|${a.rightTable}|${a.conditionNormalized}`.localeCompare(`${b.leftTable}|${b.rightTable}|${b.conditionNormalized}`)),
    source: 'refreshed-metadata',
  };

  ctx.learningStore.saveSchemaRefresh({
    datasource,
    source: refreshed.source,
    tables: refreshed.tables,
    joins: refreshed.joins,
  });
  return refreshed;
}

export function supportsSchemaRefresh(datasource?: DatasourceProfile): boolean {
  return Boolean(datasource && isSqlDatasource(datasource.kind));
}
