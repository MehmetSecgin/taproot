import type { AppContext } from '../core/app.js';
import { refreshSchemaForDatasource, supportsSchemaRefresh } from '../core/schema-refresh.js';
import { EnsuredBy } from '../types/core.js';
import type { DatasourceProfile } from '../types/core.js';
import { bareTableName, schemaObservationHasCurrentMetadata, type SchemaJoinEntry, type SchemaObservationEntry } from '../store/learning.js';
import { str } from '../core/strings.js';
import { emptyState, isTargetedRequest, resolveDatasource, scopedRows, unresolvedNextCommand, type LearnTargetOpts } from './learn-common.js';

export type SchemaIndexProjection = {
  name: string;
  columns: string[];
  unique?: boolean;
  type?: string;
};

export type TableSnapshot = {
  datasource: string;
  table: string;
  database: string;
  columns: string[];
  primaryKey: string[];
  indexes: SchemaIndexProjection[];
  partition?: SchemaObservationEntry['partition'];
  columnStats?: SchemaObservationEntry['columns'];
  metadataVersion?: number;
  sightings?: number;
  confidence?: number;
  source?: SchemaObservationEntry['sources'];
  lastSeenAt?: string;
};

export type JoinSnapshot = {
  leftTable: string;
  rightTable: string;
  condition: string;
  datasource?: string;
  sightings?: number;
  confidence?: number;
  source?: SchemaJoinEntry['sources'];
  lastSeenAt?: string;
};

export function trimIndex(index: { name?: string; columns?: string[]; unique?: boolean; type?: string }): SchemaIndexProjection {
  const out: SchemaIndexProjection = {
    name: str(index.name),
    columns: index.columns || [],
  };
  if (index.unique) out.unique = true;
  if (index.type && String(index.type).toUpperCase() !== 'BTREE') out.type = index.type;
  return out;
}

export function buildSchemaSnapshot(input: { tables: SchemaObservationEntry[]; joins: SchemaJoinEntry[]; limit: number; detailed?: boolean }): { tables: TableSnapshot[]; joins: JoinSnapshot[] } {
  const detailed = Boolean(input.detailed);
  const tables: TableSnapshot[] = [...input.tables]
    .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
    .slice(0, input.limit)
    .map((row) => {
      const compact: TableSnapshot = {
        datasource: row.datasource,
        table: row.table,
        database: row.database,
        columns: row.columns.map((column) => column.column),
        primaryKey: row.primaryKey || [],
        indexes: (row.indexes || []).map(trimIndex),
        partition: row.partition,
      };
      if (!detailed) return compact;
      return {
        ...compact,
        columnStats: row.columns,
        metadataVersion: row.metadataVersion,
        sightings: row.sightings,
        confidence: row.confidence,
        source: row.sources,
        lastSeenAt: row.lastSeenAt,
      };
    });

  const visibleTables = new Set(tables.map((row) => row.table));
  const joins: JoinSnapshot[] = [...input.joins]
    .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
    .filter((row) => visibleTables.size === 0 || visibleTables.has(row.leftTable) || visibleTables.has(row.rightTable))
    .slice(0, input.limit)
    .map((row) => {
      const compact: JoinSnapshot = {
        leftTable: row.leftTable,
        rightTable: row.rightTable,
        condition: row.conditionNormalized,
      };
      if (!detailed) return compact;
      return {
        ...compact,
        datasource: row.datasource,
        sightings: row.sightings,
        confidence: row.confidence,
        source: row.sources,
        lastSeenAt: row.lastSeenAt,
      };
    });

  return { tables, joins };
}

export interface EnsureSchemaResult {
  datasource: string | null;
  tables: TableSnapshot[];
  joins: JoinSnapshot[];
  emptyReason: string | null;
  suggestedNextCommand: string | null;
  ensuredBy: EnsuredBy;
}

function filterRequestedTables(rows: SchemaObservationEntry[], tables?: string[]): SchemaObservationEntry[] {
  const requested = new Set((tables || []).map(bareTableName).filter(Boolean));
  if (!requested.size) return rows;
  return rows.filter((row) => requested.has(bareTableName(row.table)));
}

function hasMissingRequestedTables(rows: SchemaObservationEntry[], tables?: string[]): boolean {
  const requested = new Set((tables || []).map(bareTableName).filter(Boolean));
  if (!requested.size) return false;
  const present = new Set(rows.map((row) => bareTableName(row.table)));
  return [...requested].some((table) => !present.has(table));
}

function shouldRefreshSchema(input: {
  datasource: DatasourceProfile | undefined;
  currentRows: SchemaObservationEntry[];
  requestedTables?: string[];
  emptyReason: string | null;
  forceRefresh: boolean;
}): boolean {
  if (!input.datasource || !supportsSchemaRefresh(input.datasource)) return false;
  if (input.forceRefresh) return true;
  if (input.emptyReason === 'schema_refresh_required') return true;
  if (hasMissingRequestedTables(input.currentRows, input.requestedTables)) return true;
  return input.currentRows.length > 0 && !input.currentRows.some((row) => schemaObservationHasCurrentMetadata(row));
}

export async function ensureSchemaSnapshot(
  ctx: AppContext,
  opts: LearnTargetOpts & {
    limit?: number | string;
    tables?: string[];
    metadataTimeoutMs?: number;
    detailed?: boolean;
    refresh?: boolean;
  },
): Promise<EnsureSchemaResult> {
  const datasource = await resolveDatasource(ctx, opts);
  const targeted = isTargetedRequest(opts);
  const limit = Math.max(1, Number(opts.limit || 50));
  const snapshotFromStore = () =>
    buildSchemaSnapshot({
      tables: filterRequestedTables(scopedRows({ datasource, targeted, load: (name) => ctx.learningStore.schemaTables(name) }), opts.tables),
      joins: scopedRows({ datasource, targeted, load: (name) => ctx.learningStore.schemaJoins(name) }),
      limit,
      detailed: Boolean(opts.detailed),
    });

  let snapshot = snapshotFromStore();
  let state = emptyState({
    datasource,
    rows: snapshot.tables,
    kind: 'tables',
    unresolved: Boolean(targeted && !datasource),
    suggestedNextCommand: unresolvedNextCommand(opts, ctx),
  });

  const currentRows = filterRequestedTables(scopedRows({ datasource, targeted, load: (name) => ctx.learningStore.schemaTables(name) }), opts.tables);
  const shouldRefresh = shouldRefreshSchema({
    datasource,
    currentRows,
    requestedTables: opts.tables,
    emptyReason: state.emptyReason,
    forceRefresh: Boolean(opts.refresh),
  });

  if (shouldRefresh && datasource) {
    await refreshSchemaForDatasource(ctx, datasource, {
      tables: opts.tables,
      metadataTimeoutMs: opts.metadataTimeoutMs,
    });
    snapshot = snapshotFromStore();
    state = emptyState({
      datasource,
      rows: snapshot.tables,
      kind: 'tables',
      unresolved: false,
      suggestedNextCommand: unresolvedNextCommand(opts, ctx),
    });
  }

  let ensuredBy: EnsuredBy = EnsuredBy.Empty;
  if (state.emptyReason === 'datasource_unresolved') ensuredBy = EnsuredBy.Unresolved;
  else if (snapshot.tables.length && state.emptyReason === null) {
    ensuredBy = shouldRefresh ? EnsuredBy.RefreshedIntrospection : EnsuredBy.CachedLearning;
  }

  return {
    datasource: datasource?.name || null,
    tables: snapshot.tables,
    joins: snapshot.joins,
    emptyReason: state.emptyReason,
    suggestedNextCommand: state.suggestedNextCommand,
    ensuredBy,
  };
}
