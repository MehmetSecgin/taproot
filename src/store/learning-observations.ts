import type { DatasourceProfile, SchemaProvenance } from '../types/core.js';
import { readJsonFile, writeJsonFile } from '../core/json.js';
import { str } from '../core/strings.js';
import type { ColumnRole } from '../core/schema-learning.js';
import type { RefreshedSchemaTable } from '../core/schema-refresh.js';
import {
  SCHEMA_METADATA_VERSION,
  bareTableName,
  isSystemTable,
  pickBestByKey,
  schemaObservationHasCurrentMetadata,
} from './learning-utils.js';
import type { SchemaObservationEntry, SchemaTableColumnStat } from './learning-types.js';

export function loadSchemaObservations(file: string): SchemaObservationEntry[] {
  return readJsonFile<SchemaObservationEntry[]>(file, []);
}

export function saveSchemaObservations(file: string, rows: SchemaObservationEntry[]): void {
  writeJsonFile(file, rows);
}

export function filterObservations(
  rows: SchemaObservationEntry[],
  service?: string,
): SchemaObservationEntry[] {
  if (!service) return rows;
  return rows.filter((r) => r.service === service);
}

export function mergeColumnStats(
  a: SchemaTableColumnStat[],
  b: SchemaTableColumnStat[],
): SchemaTableColumnStat[] {
  const map = new Map<string, SchemaTableColumnStat>();
  for (const stat of [...a, ...b]) {
    const prev = map.get(stat.column);
    if (!prev) {
      map.set(stat.column, { ...stat });
      continue;
    }
    map.set(stat.column, {
      column: stat.column,
      selectedCount: prev.selectedCount + stat.selectedCount,
      filterCount: prev.filterCount + stat.filterCount,
      groupCount: prev.groupCount + stat.groupCount,
      orderCount: prev.orderCount + stat.orderCount,
      lastSeenAt: prev.lastSeenAt > stat.lastSeenAt ? prev.lastSeenAt : stat.lastSeenAt,
    });
  }
  return [...map.values()].sort((x, y) => x.column.localeCompare(y.column));
}

export function mergeObservation(
  existing: SchemaObservationEntry,
  incoming: SchemaObservationEntry,
  newKey: string,
): SchemaObservationEntry {
  const completePrev = schemaObservationHasCurrentMetadata(existing);
  const completeNext = schemaObservationHasCurrentMetadata(incoming);
  const winner =
    completeNext && !completePrev
      ? incoming
      : completePrev && !completeNext
        ? existing
        : Date.parse(incoming.lastSeenAt) >= Date.parse(existing.lastSeenAt)
          ? incoming
          : existing;
  return {
    ...winner,
    key: newKey,
    aliases: Array.from(
      new Set([...(existing.aliases || []), ...(incoming.aliases || [])]),
    ).sort(),
    columns: mergeColumnStats(existing.columns || [], incoming.columns || []),
    sightings: (existing.sightings || 0) + (incoming.sightings || 0),
    confidence: Math.max(existing.confidence || 0, incoming.confidence || 0),
    sources: Array.from(
      new Set([...(existing.sources || []), ...(incoming.sources || [])]),
    ).sort() as SchemaProvenance[],
    firstSeenAt:
      existing.firstSeenAt < incoming.firstSeenAt ? existing.firstSeenAt : incoming.firstSeenAt,
    lastSeenAt:
      existing.lastSeenAt > incoming.lastSeenAt ? existing.lastSeenAt : incoming.lastSeenAt,
  };
}

export function migrateSchemaObservationsFile(file: string): void {
  const observations = loadSchemaObservations(file);
  if (!observations.length) return;
  const merged = new Map<string, SchemaObservationEntry>();
  let changed = false;
  for (const row of observations) {
    if (!row.service || !row.table) {
      if (!changed) changed = true;
      continue;
    }
    const tableLower = String(row.table).toLowerCase();
    if (
      tableLower.startsWith('information_schema.') ||
      tableLower.startsWith('performance_schema.') ||
      tableLower.startsWith('mysql.')
    ) {
      changed = true;
      continue;
    }
    const bareTable = bareTableName(row.table);
    if (!bareTable) {
      changed = true;
      continue;
    }
    if (bareTable !== row.table) {
      changed = true;
      row.table = bareTable;
    }
    const newKey = `${row.service}|${row.table}`;
    if (row.key !== newKey) changed = true;
    const existing = merged.get(newKey);
    if (existing) {
      changed = true;
      merged.set(newKey, mergeObservation(existing, row, newKey));
    } else {
      merged.set(newKey, { ...row, key: newKey });
    }
  }
  if (changed) {
    const next = [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
    saveSchemaObservations(file, next);
  }
}

export function upsertColumnStat(
  columns: SchemaTableColumnStat[],
  column: string,
  role: ColumnRole,
  now: string,
): SchemaTableColumnStat[] {
  const idx = columns.findIndex((c) => c.column === column);
  const prev =
    idx >= 0
      ? columns[idx]
      : {
          column,
          selectedCount: 0,
          filterCount: 0,
          groupCount: 0,
          orderCount: 0,
          lastSeenAt: now,
        };
  const next: SchemaTableColumnStat = {
    ...prev,
    lastSeenAt: now,
    selectedCount: prev.selectedCount + (role === 'select' ? 1 : 0),
    filterCount: prev.filterCount + (role === 'filter' ? 1 : 0),
    groupCount: prev.groupCount + (role === 'group' ? 1 : 0),
    orderCount: prev.orderCount + (role === 'order' ? 1 : 0),
  };
  if (idx >= 0) columns[idx] = next;
  else columns.push(next);
  return columns;
}

export function upsertObservationsFromObservedQuery(
  rows: SchemaObservationEntry[],
  input: {
    datasource: DatasourceProfile;
    tables: { table: string; alias?: string }[];
    columns: { table?: string; column: string; role: ColumnRole }[];
    now: string;
  },
): SchemaObservationEntry[] {
  const datasource = input.datasource;
  const env = str(datasource.env);
  const service = str(datasource.service);
  const database = str(datasource.connection.database);
  const target = str(datasource.connection.target);

  const aliasesByTable = new Map<string, string[]>();
  for (const t of input.tables) {
    if (isSystemTable(t.table)) continue;
    const baseTable = bareTableName(t.table);
    if (!baseTable) continue;
    if (!aliasesByTable.has(baseTable)) aliasesByTable.set(baseTable, []);
    if (t.alias && !aliasesByTable.get(baseTable)?.includes(t.alias)) {
      aliasesByTable.get(baseTable)?.push(t.alias);
    }
  }

  const columnTableFallback =
    aliasesByTable.size === 1 ? [...aliasesByTable.keys()][0] : '';
  for (const [table, aliases] of aliasesByTable.entries()) {
    const key = [service, table].join('|');
    const idx = rows.findIndex((o) => o.key === key);
    const prev = idx >= 0 ? rows[idx] : undefined;
    const nextColumns = [...(prev?.columns || [])];
    for (const c of input.columns) {
      const colTableRaw = c.table || columnTableFallback;
      const colTable = bareTableName(colTableRaw);
      if (!colTable || colTable !== table) continue;
      upsertColumnStat(nextColumns, c.column, c.role, input.now);
    }
    const next: SchemaObservationEntry = {
      key,
      metadataVersion: prev?.metadataVersion,
      datasource: datasource.name,
      env,
      service,
      kind: datasource.kind,
      database,
      target,
      table,
      aliases: Array.from(new Set([...(prev?.aliases || []), ...aliases])).sort(),
      columns: nextColumns.sort((a, b) => a.column.localeCompare(b.column)),
      primaryKey: prev?.primaryKey,
      indexes: prev?.indexes,
      partition: prev?.partition,
      firstSeenAt: prev?.firstSeenAt || input.now,
      lastSeenAt: input.now,
      sightings: (prev?.sightings || 0) + 1,
      confidence: Math.min(1, Math.max(0.35, (prev?.confidence || 0.65) + 0.03)),
      sources: Array.from(
        new Set([...(prev?.sources || []), 'observed-query']),
      ).sort() as SchemaProvenance[],
    };
    if (idx >= 0) rows[idx] = next;
    else rows.push(next);
  }
  return rows;
}

export function upsertObservationsFromRefresh(
  rows: SchemaObservationEntry[],
  input: {
    datasource: DatasourceProfile;
    source: SchemaProvenance;
    tables: RefreshedSchemaTable[];
    now: string;
  },
): SchemaObservationEntry[] {
  const datasource = input.datasource;
  const env = str(datasource.env);
  const service = str(datasource.service);
  const database = str(datasource.connection.database);
  const target = str(datasource.connection.target);

  for (const table of input.tables) {
    const key = [service, table.table].join('|');
    const idx = rows.findIndex((row) => row.key === key);
    const prev = idx >= 0 ? rows[idx] : undefined;
    const nextColumns = table.columns.map((column) => {
      const existing = prev?.columns.find((item) => item.column === column);
      return {
        column,
        selectedCount: existing?.selectedCount || 0,
        filterCount: existing?.filterCount || 0,
        groupCount: existing?.groupCount || 0,
        orderCount: existing?.orderCount || 0,
        lastSeenAt: input.now,
      };
    });
    const next: SchemaObservationEntry = {
      key,
      metadataVersion: table.metadataVersion || SCHEMA_METADATA_VERSION,
      datasource: datasource.name,
      env,
      service,
      kind: datasource.kind,
      database,
      target,
      table: table.table,
      aliases: prev?.aliases || [],
      columns: nextColumns,
      primaryKey: table.primaryKey || prev?.primaryKey || [],
      indexes: table.indexes || prev?.indexes || [],
      partition: table.partition || prev?.partition,
      firstSeenAt: prev?.firstSeenAt || input.now,
      lastSeenAt: input.now,
      sightings: (prev?.sightings || 0) + 1,
      confidence: Math.min(1, Math.max(0.55, prev?.confidence || 0.8)),
      sources: Array.from(
        new Set([...(prev?.sources || []), input.source]),
      ).sort() as SchemaProvenance[],
    };
    if (idx >= 0) rows[idx] = next;
    else rows.push(next);
  }
  return rows;
}

export function compactObservations(
  rows: SchemaObservationEntry[],
): SchemaObservationEntry[] {
  return pickBestByKey(
    rows,
    (a, b) => a.sightings > b.sightings || a.lastSeenAt > b.lastSeenAt,
  );
}

export function pruneObservations(
  rows: SchemaObservationEntry[],
  cutoffMs: number,
): SchemaObservationEntry[] {
  return rows.filter((r) => new Date(r.lastSeenAt).getTime() >= cutoffMs);
}
