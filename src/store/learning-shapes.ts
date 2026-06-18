import type { DatasourceProfile, SchemaProvenance } from '../types/core.js';
import { readJsonFile, writeJsonFile } from '../core/json.js';
import { str } from '../core/strings.js';
import { pickBestByKey } from './learning-utils.js';
import type { SchemaQueryShapeEntry } from './learning-types.js';

export function loadSchemaShapes(file: string): SchemaQueryShapeEntry[] {
  return readJsonFile<SchemaQueryShapeEntry[]>(file, []);
}

export function saveSchemaShapes(file: string, rows: SchemaQueryShapeEntry[]): void {
  writeJsonFile(file, rows);
}

export function filterShapes(
  rows: SchemaQueryShapeEntry[],
  datasourceName?: string,
): SchemaQueryShapeEntry[] {
  if (!datasourceName) return rows;
  return rows.filter((r) => r.datasource === datasourceName);
}

export function upsertShapeFromObservedQuery(
  rows: SchemaQueryShapeEntry[],
  input: {
    datasource: DatasourceProfile;
    operation: string;
    normalizedSql: string;
    tables: { table: string }[];
    joins: { leftTable: string; rightTable: string }[];
    confidence: number;
    now: string;
  },
): SchemaQueryShapeEntry {
  const datasource = input.datasource;
  const database = str(datasource.connection.database);
  const key = [datasource.name, database, input.operation, input.normalizedSql].join('|');
  const idx = rows.findIndex((o) => o.key === key);
  const prev = idx >= 0 ? rows[idx] : undefined;
  const next: SchemaQueryShapeEntry = {
    key,
    datasource: datasource.name,
    env: str(datasource.env),
    service: str(datasource.service),
    kind: datasource.kind,
    database,
    operation: input.operation,
    normalizedSql: input.normalizedSql,
    tables: Array.from(new Set(input.tables.map((t) => t.table))).sort(),
    joins: Array.from(new Set(input.joins.map((j) => `${j.leftTable}->${j.rightTable}`))).sort(),
    firstSeenAt: prev?.firstSeenAt || input.now,
    lastSeenAt: input.now,
    sightings: (prev?.sightings || 0) + 1,
    confidence: Math.min(1, Math.max(0.35, (prev?.confidence || input.confidence) + 0.02)),
    sources: Array.from(
      new Set([...(prev?.sources || []), 'observed-query']),
    ).sort() as SchemaProvenance[],
  };
  if (idx >= 0) rows[idx] = next;
  else rows.push(next);
  return next;
}

export function upsertShapeFromRefresh(
  rows: SchemaQueryShapeEntry[],
  input: {
    datasource: DatasourceProfile;
    source: SchemaProvenance;
    tables: { table: string }[];
    joins: { leftTable: string; rightTable: string }[];
    now: string;
  },
): SchemaQueryShapeEntry {
  const datasource = input.datasource;
  const database = str(datasource.connection.database);
  const tableNames = input.tables.map((t) => t.table).sort();
  const key = [datasource.name, database, 'metadata-refresh', tableNames.join(',')].join('|');
  const idx = rows.findIndex((row) => row.key === key);
  const prev = idx >= 0 ? rows[idx] : undefined;
  const next: SchemaQueryShapeEntry = {
    key,
    datasource: datasource.name,
    env: str(datasource.env),
    service: str(datasource.service),
    kind: datasource.kind,
    database,
    operation: 'metadata-refresh',
    normalizedSql: `metadata-refresh:${tableNames.join(',')}`,
    tables: tableNames.sort((a, b) => a.localeCompare(b)),
    joins: input.joins
      .map((j) => `${j.leftTable}->${j.rightTable}`)
      .sort((a, b) => a.localeCompare(b)),
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
  return next;
}

export function compactShapes(rows: SchemaQueryShapeEntry[]): SchemaQueryShapeEntry[] {
  return pickBestByKey(
    rows,
    (a, b) => a.sightings > b.sightings || a.lastSeenAt > b.lastSeenAt,
  );
}

export function pruneShapes(
  rows: SchemaQueryShapeEntry[],
  cutoffMs: number,
): SchemaQueryShapeEntry[] {
  return rows.filter((r) => new Date(r.lastSeenAt).getTime() >= cutoffMs);
}
