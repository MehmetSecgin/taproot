import type { AppContext } from './app.js';
import { runDatasourceConnectors } from './app.js';
import { DatasourceKind, DoctorStatus } from '../types/core.js';
import type { DatasourceProfile, QueryResult, RpcEnumShape, RpcMessageShape, RpcServiceShape, SchemaIndex, SchemaPartition, SchemaProvenance } from '../types/core.js';
import { RUNTIME_CONSTANTS } from './constants.js';
import { connectivity } from './error-classification.js';
import { withQueryTimeout } from './query-timeout.js';
import { DEFAULT_SESSION_TIME_ZONE } from './session-timezone.js';
import { SCHEMA_METADATA_VERSION } from '../store/learning.js';
import { loadProtobufRoot } from './proto-loader.js';
import { describeProto } from './grpc-introspect.js';

export interface RefreshedSchemaTable {
  table: string;
  columns: string[];
  metadataVersion?: number;
  primaryKey?: string[];
  indexes?: SchemaIndex[];
  partition?: SchemaPartition;
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

function escapeSqlIdentifierValue(value: string): string {
  return escapeSqlString(value.replace(/`/g, '').split('.').pop() || value);
}

function tableFilterSql(tables?: string[]): string {
  const normalized = Array.from(
    new Set((tables || []).map((table) => escapeSqlIdentifierValue(String(table || '').trim())).filter(Boolean)),
  );
  if (!normalized.length) return '';
  return ` AND table_name IN (${normalized.map((table) => `'${table}'`).join(', ')})`;
}

const SQL_DATASOURCE_KINDS: readonly string[] = [
  DatasourceKind.Mysql,
  DatasourceKind.Postgres,
  DatasourceKind.TeleportMysql,
];

function isSqlDatasource(kind: string): boolean {
  return SQL_DATASOURCE_KINDS.includes(String(kind || '').trim());
}

function tableSql(datasource: DatasourceProfile, tables?: string[]): string {
  const database = escapeSqlString(String(datasource.connection.database || ''));
  if (datasource.kind === DatasourceKind.Postgres) {
    return [
      'SELECT table_name AS table_name, column_name AS column_name',
      'FROM information_schema.columns',
      `WHERE table_catalog = '${database}'`,
      "  AND table_schema NOT IN ('information_schema', 'pg_catalog')",
      tables?.length ? `  AND table_name IN (${tables.map((table) => `'${escapeSqlIdentifierValue(table)}'`).join(', ')})` : '',
      'ORDER BY table_name, ordinal_position',
    ].filter(Boolean).join(' ');
  }
  return [
    'SELECT table_name AS table_name, column_name AS column_name',
    'FROM information_schema.columns',
    `WHERE table_schema = '${database}'`,
    tableFilterSql(tables),
    'ORDER BY table_name, ordinal_position',
  ].filter(Boolean).join(' ');
}

function joinSql(datasource: DatasourceProfile, tables?: string[]): string {
  const database = escapeSqlString(String(datasource.connection.database || ''));
  const tableFilter = tableFilterSql(tables);
  if (datasource.kind === DatasourceKind.Postgres) {
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
      tables?.length ? `  AND (tc.table_name IN (${tables.map((table) => `'${escapeSqlIdentifierValue(table)}'`).join(', ')}) OR ccu.table_name IN (${tables.map((table) => `'${escapeSqlIdentifierValue(table)}'`).join(', ')}))` : '',
      'ORDER BY tc.table_name, ccu.table_name, kcu.ordinal_position',
    ].filter(Boolean).join(' ');
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
    tableFilter ? tableFilter.replace('table_name IN', '(table_name IN').replace(/\)$/, ') OR referenced_table_name IN (' + Array.from(new Set((tables || []).map((table) => `'${escapeSqlIdentifierValue(table)}'`))).join(', ') + '))') : '',
    'ORDER BY table_name, referenced_table_name, ordinal_position',
  ].filter(Boolean).join(' ');
}

function indexSql(datasource: DatasourceProfile, tables?: string[]): string {
  const database = escapeSqlString(String(datasource.connection.database || ''));
  return [
    'SELECT table_name, index_name, seq_in_index, column_name, non_unique, index_type',
    'FROM information_schema.statistics',
    `WHERE table_schema = '${database}'`,
    tableFilterSql(tables),
    'ORDER BY table_name, index_name, seq_in_index',
  ].filter(Boolean).join(' ');
}

function partitionSql(datasource: DatasourceProfile, tables?: string[]): string {
  const database = escapeSqlString(String(datasource.connection.database || ''));
  return [
    'SELECT table_name, partition_method, partition_expression, subpartition_method, subpartition_expression',
    'FROM information_schema.partitions',
    `WHERE table_schema = '${database}'`,
    '  AND partition_name IS NOT NULL',
    tableFilterSql(tables),
    'ORDER BY table_name, partition_ordinal_position',
  ].filter(Boolean).join(' ');
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

async function executeReadMaybeTimed(ctx: AppContext, datasource: DatasourceProfile, sql: string, timeoutMs?: number): Promise<QueryResult> {
  if (!timeoutMs) return executeRead(ctx, datasource, sql);
  return withQueryTimeout({
    timeoutMs,
    run: () => executeRead(ctx, datasource, sql),
  });
}

function isAccessDenied(error: unknown): boolean {
  const message = String((error as Error)?.message || error || '').toLowerCase();
  return /access denied|permission denied|select command denied|denied to user/.test(message);
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

function parseCreateTable(table: string, createSql: string): RefreshedSchemaTable {
  const columns: string[] = [];
  const indexes: SchemaIndex[] = [];
  let primaryKey: string[] = [];
  let partition: SchemaPartition | undefined;

  for (const rawLine of createSql.split('\n')) {
    const line = rawLine.trim().replace(/,$/, '');
    const columnMatch = line.match(/^`([^`]+)`\s+/);
    if (columnMatch) columns.push(columnMatch[1]);

    const primaryMatch = line.match(/^PRIMARY\s+KEY\s*\((.+)\)/i);
    if (primaryMatch) {
      primaryKey = extractBacktickColumns(primaryMatch[1]);
      indexes.push({ name: 'PRIMARY', columns: primaryKey, unique: true });
      continue;
    }

    const keyMatch = line.match(/^(UNIQUE\s+)?(?:KEY|INDEX)\s+`([^`]+)`\s*\((.+)\)/i);
    if (keyMatch) {
      indexes.push({
        name: keyMatch[2],
        columns: extractBacktickColumns(keyMatch[3]),
        unique: Boolean(keyMatch[1]),
      });
    }
  }

  const partitionMatch = createSql.match(/PARTITION\s+BY\s+((?:LINEAR\s+)?(?:RANGE|LIST|HASH|KEY)(?:\s+COLUMNS)?)\s*\(([^)]+)\)/i);
  if (partitionMatch) partition = parsePartition(partitionMatch[1], partitionMatch[2]);

  return {
    table,
    columns: Array.from(new Set(columns)).sort((a, b) => a.localeCompare(b)),
    metadataVersion: SCHEMA_METADATA_VERSION,
    primaryKey,
    indexes,
    partition,
  };
}

function createTableSql(datasource: DatasourceProfile, table: string): string {
  const database = String(datasource.connection.database || '').replace(/`/g, '');
  const bareTable = escapeSqlIdentifierValue(table);
  return database ? `SHOW CREATE TABLE \`${database}\`.\`${bareTable}\`` : `SHOW CREATE TABLE \`${bareTable}\``;
}

async function refreshFromShowCreate(
  ctx: AppContext,
  datasource: DatasourceProfile,
  tables: string[],
  timeoutMs?: number,
): Promise<Pick<SchemaRefreshResult, 'tables' | 'joins'>> {
  const refreshed: RefreshedSchemaTable[] = [];
  for (const rawTable of tables) {
    const table = escapeSqlIdentifierValue(rawTable);
    const result = await executeReadMaybeTimed(ctx, datasource, createTableSql(datasource, table), timeoutMs);
    const row = result.result.rows[0] || {};
    const createSql = Object.entries(row).find(([key, value]) => /create\s+table/i.test(key) && typeof value === 'string')?.[1];
    if (typeof createSql === 'string' && createSql.trim()) refreshed.push(parseCreateTable(table, createSql));
  }
  return { tables: refreshed, joins: [] };
}

export async function refreshSchemaForDatasource(
  ctx: AppContext,
  datasource: DatasourceProfile,
  opts: { tables?: string[]; metadataTimeoutMs?: number } = {},
): Promise<SchemaRefreshResult> {
  if (!isSqlDatasource(datasource.kind)) {
    throw new Error(`learning_unsupported: datasource kind '${datasource.kind}' does not support schema refresh`);
  }
  const targetTables = Array.from(new Set((opts.tables || []).map((table) => escapeSqlIdentifierValue(table)).filter(Boolean)));
  let tableResult: QueryResult;
  let joinResult: QueryResult;
  let indexResult: QueryResult | undefined;
  let partitionResult: QueryResult | undefined;
  try {
    tableResult = await executeReadMaybeTimed(ctx, datasource, tableSql(datasource, targetTables), opts.metadataTimeoutMs);
    joinResult = await executeReadMaybeTimed(ctx, datasource, joinSql(datasource, targetTables), opts.metadataTimeoutMs);
    if (datasource.kind !== DatasourceKind.Postgres) {
      indexResult = await executeReadMaybeTimed(ctx, datasource, indexSql(datasource, targetTables), opts.metadataTimeoutMs);
      partitionResult = await executeReadMaybeTimed(ctx, datasource, partitionSql(datasource, targetTables), opts.metadataTimeoutMs);
    }
  } catch (error) {
    if (targetTables.length && isAccessDenied(error) && datasource.kind !== DatasourceKind.Postgres) {
      const fallback = await refreshFromShowCreate(ctx, datasource, targetTables, opts.metadataTimeoutMs);
      const refreshed: SchemaRefreshResult = {
        datasource: datasource.name,
        database: String(datasource.connection.database || ''),
        tables: fallback.tables.sort((a, b) => a.table.localeCompare(b.table)),
        joins: fallback.joins,
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
    throw error;
  }

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

  const indexesByTable = new Map<string, Map<string, SchemaIndex & { _seq?: number[] }>>();
  for (const row of indexResult?.result.rows || []) {
    const table = String(row.table_name || '').trim();
    const name = String(row.index_name || '').trim();
    const column = String(row.column_name || '').trim();
    if (!table || !name || !column) continue;
    const byName = indexesByTable.get(table) || new Map<string, SchemaIndex & { _seq?: number[] }>();
    const prev = byName.get(name) || {
      name,
      columns: [],
      unique: String(row.non_unique ?? '1') === '0',
      type: String(row.index_type || '').trim() || undefined,
      _seq: [],
    };
    prev.columns.push(column);
    prev._seq?.push(Number(row.seq_in_index || prev.columns.length));
    byName.set(name, prev);
    indexesByTable.set(table, byName);
  }

  const partitionsByTable = new Map<string, SchemaPartition>();
  for (const row of partitionResult?.result.rows || []) {
    const table = String(row.table_name || '').trim();
    if (!table || partitionsByTable.has(table)) continue;
    const method = String(row.partition_method || row.subpartition_method || '').trim();
    const expr = String(row.partition_expression || row.subpartition_expression || '').trim();
    const partition = parsePartition(method, expr);
    if (partition) partitionsByTable.set(table, partition);
  }

  const refreshed: SchemaRefreshResult = {
    datasource: datasource.name,
    database: String(datasource.connection.database || ''),
    tables: [...tables.entries()]
      .map(([table, columns]) => {
        const indexes = Array.from(indexesByTable.get(table)?.values() || [])
          .map(({ _seq, ...index }) => index)
          .filter((index) => index.columns.length);
        const primaryKey = indexes.find((index) => index.name === 'PRIMARY')?.columns || [];
        return {
          table,
          columns: [...columns].sort((a, b) => a.localeCompare(b)),
          metadataVersion: SCHEMA_METADATA_VERSION,
          primaryKey,
          indexes,
          partition: partitionsByTable.get(table),
        };
      })
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

export type CatalogEnsureOutcome = 'unsupported' | 'cached' | 'fetched' | 'failed';

export interface CatalogEnsureResult {
  outcome: CatalogEnsureOutcome;
  tableCount: number;
  fetchedAt?: string;
  error?: string;
}

export async function ensureDatasourceCatalog(
  ctx: AppContext,
  datasource: DatasourceProfile,
): Promise<CatalogEnsureResult> {
  if (!supportsSchemaRefresh(datasource)) return { outcome: 'unsupported', tableCount: 0 };

  const cached = ctx.learningStore.schemaCatalog(datasource.name);
  if (cached) {
    const fetched = Date.parse(cached.fetchedAt);
    const ttlMs = RUNTIME_CONSTANTS.query.catalogTtlHours * 3600 * 1000;
    if (Number.isFinite(fetched) && Date.now() - fetched < ttlMs) {
      return { outcome: 'cached', tableCount: cached.tableCount, fetchedAt: cached.fetchedAt };
    }
  }

  try {
    const refreshed = await refreshSchemaForDatasource(ctx, datasource, {
      metadataTimeoutMs: RUNTIME_CONSTANTS.query.catalogTimeoutMs,
    });
    const entry = ctx.learningStore.saveSchemaCatalog({ datasource, tableCount: refreshed.tables.length });
    return { outcome: 'fetched', tableCount: entry.tableCount, fetchedAt: entry.fetchedAt };
  } catch (error) {
    return { outcome: 'failed', tableCount: cached?.tableCount || 0, error: (error as Error).message };
  }
}

export interface GrpcSchemaRefreshResult {
  datasource: string;
  protoRoot: string;
  services: RpcServiceShape[];
  messages: Record<string, RpcMessageShape>;
  enums: Record<string, RpcEnumShape>;
}

export function supportsGrpcSchema(datasource?: DatasourceProfile): boolean {
  return Boolean(datasource && datasource.kind === DatasourceKind.Grpc && (datasource.resolverHints || {}).protoRoot);
}

export async function refreshGrpcSchemaForDatasource(
  ctx: AppContext,
  datasource: DatasourceProfile,
): Promise<GrpcSchemaRefreshResult> {
  if (datasource.kind !== 'grpc') {
    throw new Error(`learning_unsupported: datasource kind '${datasource.kind}' does not support grpc schema refresh`);
  }
  const protoRoot = String((datasource.resolverHints || {}).protoRoot || '').trim();
  if (!protoRoot) {
    throw new Error(`executor_configuration_missing: grpc datasource '${datasource.name}' has no resolverHints.protoRoot. Add via 'taproot datasource add ... --hint protoRoot=<dir>'.`);
  }
  const { protobufRoot } = await loadProtobufRoot(protoRoot);
  const descriptor = describeProto(protobufRoot, { expand: { maxDepth: 6 } });
  ctx.learningStore.saveGrpcSchema({
    datasource,
    protoRoot,
    source: 'refreshed-metadata',
    services: descriptor.services,
    messages: descriptor.messages,
    enums: descriptor.enums,
  });
  return { datasource: datasource.name, protoRoot, services: descriptor.services, messages: descriptor.messages, enums: descriptor.enums };
}
