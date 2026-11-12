import type { AppContext } from './app.js';
import { runDatasourceConnectors } from './app.js';
import { DoctorStatus, SQL_DATASOURCE_KINDS } from '../types/core.js';
import type { DatasourceProfile, QueryResult, SchemaIndex, SchemaPartition, TableContext } from '../types/core.js';
import { RUNTIME_CONSTANTS } from './constants.js';
import { connectivity } from './error-classification.js';
import { withQueryTimeout } from './query-timeout.js';
import { DEFAULT_SESSION_TIME_ZONE } from './session-timezone.js';

function escapeSqlString(value: string): string {
  return value.replace(/'/g, "''");
}

function databaseLiteral(datasource: DatasourceProfile): string {
  return escapeSqlString(String(datasource.connection.database || ''));
}

function tableSql(datasource: DatasourceProfile): string {
  const database = databaseLiteral(datasource);
  return [
    'SELECT table_name AS table_name, column_name AS column_name',
    'FROM information_schema.columns',
    `WHERE table_schema = '${database}'`,
    'ORDER BY table_name, ordinal_position',
  ].join(' ');
}

function indexSql(datasource: DatasourceProfile): string {
  return [
    'SELECT table_name, index_name, seq_in_index, column_name, non_unique, index_type',
    'FROM information_schema.statistics',
    `WHERE table_schema = '${databaseLiteral(datasource)}'`,
    'ORDER BY table_name, index_name, seq_in_index',
  ].join(' ');
}

function partitionSql(datasource: DatasourceProfile): string {
  return [
    'SELECT table_name, partition_method, partition_expression, subpartition_method, subpartition_expression',
    'FROM information_schema.partitions',
    `WHERE table_schema = '${databaseLiteral(datasource)}'`,
    '  AND partition_name IS NOT NULL',
    'ORDER BY table_name, partition_ordinal_position',
  ].join(' ');
}

async function executeRead(ctx: AppContext, datasource: DatasourceProfile, sql: string): Promise<QueryResult> {
  const plugin = ctx.pluginRegistry.get(datasource.kind);
  if (!plugin?.execute) throw new Error(`no execute plugin for datasource kind '${datasource.kind}'`);
  const creds = await ctx.credentialStore.get(datasource.credentialRef);
  const connectorChecks = await runDatasourceConnectors({
    datasource,
    credentialStore: ctx.credentialStore,
    pluginRegistry: ctx.pluginRegistry,
    mode: 'connect',
  });
  if (connectorChecks.some((c) => c.status === DoctorStatus.Fail)) {
    throw connectivity(`connector preflight failed: ${connectorChecks.filter((c) => c.status === DoctorStatus.Fail).map((c) => c.detail).join(' | ')}`);
  }
  return plugin.execute(
    {
      datasource,
      query: sql,
      capability: 'executeRead',
      sessionTimeZone: DEFAULT_SESSION_TIME_ZONE,
    },
    creds,
  );
}

function executeCatalogRead(ctx: AppContext, datasource: DatasourceProfile, sql: string): Promise<QueryResult> {
  return withQueryTimeout({ timeoutMs: RUNTIME_CONSTANTS.query.catalogTimeoutMs, run: () => executeRead(ctx, datasource, sql) });
}

function extractBacktickColumns(value: string): string[] {
  return Array.from(value.matchAll(/`([^`]+)`/g)).map((m) => m[1]).filter(Boolean);
}

function splitTopLevelCsv(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of value) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      out.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

function derivePartitionKeys(expr: string): string[] {
  const parts = splitTopLevelCsv(expr);
  const keys: string[] = [];
  for (const part of parts) {
    const stripped = part.replace(/`/g, '').trim();
    if (/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(stripped)) {
      keys.push(stripped);
      continue;
    }
    const backtickCols = extractBacktickColumns(part);
    if (backtickCols.length === 1) {
      keys.push(backtickCols[0]);
      continue;
    }
    const identifiers = Array.from(stripped.matchAll(/\b[a-zA-Z_][a-zA-Z0-9_]*\b/g))
      .map((m) => m[0])
      .filter((id) => !/^(to_days|unix_timestamp|year|month|day|date|range|list|columns)$/i.test(id));
    if (identifiers.length === 1) keys.push(identifiers[0]);
  }
  return Array.from(new Set(keys));
}

function parsePartition(kindRaw: string, exprRaw: string): SchemaPartition | undefined {
  const kind = String(kindRaw || '').trim().split(/\s+/)[0]?.toUpperCase();
  const expr = String(exprRaw || '').trim();
  if (!kind || !expr) return undefined;
  const keys = derivePartitionKeys(expr);
  return { kind, expr, keys, key: keys.length === 1 ? keys[0] : undefined };
}

async function fetchSchemaCatalog(ctx: AppContext, datasource: DatasourceProfile): Promise<Record<string, TableContext>> {
  const tableResult = await executeCatalogRead(ctx, datasource, tableSql(datasource));
  const indexResult = await executeCatalogRead(ctx, datasource, indexSql(datasource));
  const partitionResult = await executeCatalogRead(ctx, datasource, partitionSql(datasource));

  const columnsByTable = new Map<string, Set<string>>();
  for (const row of tableResult.result.rows) {
    const table = String(row.table_name || '').trim();
    const column = String(row.column_name || '').trim();
    if (!table) continue;
    const set = columnsByTable.get(table) || new Set<string>();
    if (column) set.add(column);
    columnsByTable.set(table, set);
  }

  const indexesByTable = new Map<string, Map<string, SchemaIndex>>();
  for (const row of indexResult.result.rows) {
    const table = String(row.table_name || '').trim();
    const name = String(row.index_name || '').trim();
    const column = String(row.column_name || '').trim();
    if (!table || !name || !column) continue;
    const byName = indexesByTable.get(table) || new Map<string, SchemaIndex>();
    const index = byName.get(name) || { name, columns: [] };
    if (String(row.non_unique ?? '1') === '0') index.unique = true;
    const type = String(row.index_type || '').trim();
    if (type && type.toUpperCase() !== 'BTREE') index.type = type;
    index.columns.push(column);
    byName.set(name, index);
    indexesByTable.set(table, byName);
  }

  const partitionsByTable = new Map<string, SchemaPartition>();
  for (const row of partitionResult.result.rows) {
    const table = String(row.table_name || '').trim();
    if (!table || partitionsByTable.has(table)) continue;
    const method = String(row.partition_method || row.subpartition_method || '').trim();
    const expr = String(row.partition_expression || row.subpartition_expression || '').trim();
    const partition = parsePartition(method, expr);
    if (partition) partitionsByTable.set(table, partition);
  }

  const database = String(datasource.connection.database || '');
  const tables: Record<string, TableContext> = {};
  for (const [table, columns] of [...columnsByTable.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const indexes = [...(indexesByTable.get(table)?.values() || [])];
    tables[table] = {
      database,
      columns: [...columns],
      primaryKey: indexes.find((index) => index.name === 'PRIMARY')?.columns || [],
      indexes,
      partition: partitionsByTable.get(table),
    };
  }
  return tables;
}

export interface CatalogEnsureResult {
  outcome: 'unsupported' | 'cached' | 'fetched' | 'failed';
  tableCount: number;
  error?: string;
}

const catalogFetches = new Map<string, Promise<CatalogEnsureResult>>();

export function ensureDatasourceCatalog(
  ctx: AppContext,
  datasource: DatasourceProfile,
  opts: { force?: boolean } = {},
): Promise<CatalogEnsureResult> {
  if (!SQL_DATASOURCE_KINDS.has(datasource.kind)) return Promise.resolve({ outcome: 'unsupported', tableCount: 0 });
  const cached = ctx.schemaCatalogStore.get(datasource.name);
  const cachedCount = Object.keys(cached?.tables || {}).length;
  const ttlMs = RUNTIME_CONSTANTS.query.catalogTtlHours * 3600 * 1000;
  if (!opts.force && cached && Date.now() - Date.parse(cached.fetchedAt) < ttlMs) return Promise.resolve({ outcome: 'cached', tableCount: cachedCount });
  const running = catalogFetches.get(datasource.name);
  if (running) return running;
  const fetch = fetchSchemaCatalog(ctx, datasource)
    .then((tables): CatalogEnsureResult => {
      ctx.schemaCatalogStore.save(datasource.name, tables);
      return { outcome: 'fetched', tableCount: Object.keys(tables).length };
    })
    .catch((error): CatalogEnsureResult => ({ outcome: 'failed', tableCount: cachedCount, error: (error as Error).message }))
    .finally(() => catalogFetches.delete(datasource.name));
  catalogFetches.set(datasource.name, fetch);
  return fetch;
}
