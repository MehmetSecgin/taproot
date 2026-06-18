import type { DatasourceProfile, SchemaProvenance } from '../types/core.js';
import { readJsonFile, writeJsonFile } from '../core/json.js';
import { str } from '../core/strings.js';
import { bareTableName, isSystemTable, pickBestByKey } from './learning-utils.js';
import type { SchemaJoinEntry } from './learning-types.js';

export function loadSchemaJoins(file: string): SchemaJoinEntry[] {
  return readJsonFile<SchemaJoinEntry[]>(file, []);
}

export function saveSchemaJoins(file: string, rows: SchemaJoinEntry[]): void {
  writeJsonFile(file, rows);
}

export function filterJoins(rows: SchemaJoinEntry[], service?: string): SchemaJoinEntry[] {
  if (!service) return rows;
  return rows.filter((r) => r.service === service);
}

export function migrateSchemaJoinsFile(file: string): void {
  const joins = loadSchemaJoins(file);
  if (!joins.length) return;
  const merged = new Map<string, SchemaJoinEntry>();
  let changed = false;
  for (const row of joins) {
    if (!row.service || !row.leftTable || !row.rightTable) {
      if (!changed) changed = true;
      continue;
    }
    const leftBare = bareTableName(row.leftTable);
    const rightBare = bareTableName(row.rightTable);
    if (!leftBare || !rightBare) {
      changed = true;
      continue;
    }
    if (leftBare !== row.leftTable || rightBare !== row.rightTable) {
      changed = true;
      row.leftTable = leftBare;
      row.rightTable = rightBare;
    }
    const newKey = [row.service, row.leftTable, row.rightTable, row.conditionNormalized].join('|');
    if (row.key !== newKey) changed = true;
    const existing = merged.get(newKey);
    if (existing) {
      changed = true;
      merged.set(newKey, {
        ...existing,
        ...row,
        key: newKey,
        sightings: (existing.sightings || 0) + (row.sightings || 0),
        confidence: Math.max(existing.confidence || 0, row.confidence || 0),
        sources: Array.from(
          new Set([...(existing.sources || []), ...(row.sources || [])]),
        ).sort() as SchemaProvenance[],
        firstSeenAt:
          existing.firstSeenAt < row.firstSeenAt ? existing.firstSeenAt : row.firstSeenAt,
        lastSeenAt: existing.lastSeenAt > row.lastSeenAt ? existing.lastSeenAt : row.lastSeenAt,
      });
    } else {
      merged.set(newKey, { ...row, key: newKey });
    }
  }
  if (changed) {
    const next = [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
    saveSchemaJoins(file, next);
  }
}

export function upsertJoinsFromObservedQuery(
  rows: SchemaJoinEntry[],
  input: {
    datasource: DatasourceProfile;
    joins: {
      leftTable: string;
      rightTable: string;
      directionHint: 'left-to-right' | 'right-to-left' | 'unknown';
      conditionRaw: string;
      conditionNormalized: string;
    }[];
    schemaConfidence: number;
    now: string;
  },
): SchemaJoinEntry[] {
  const datasource = input.datasource;
  const env = str(datasource.env);
  const service = str(datasource.service);
  const database = str(datasource.connection.database);
  for (const j of input.joins) {
    if (isSystemTable(j.leftTable) || isSystemTable(j.rightTable)) continue;
    const leftBare = bareTableName(j.leftTable);
    const rightBare = bareTableName(j.rightTable);
    if (!leftBare || !rightBare) continue;
    const key = [service, leftBare, rightBare, j.conditionNormalized].join('|');
    const idx = rows.findIndex((o) => o.key === key);
    const prev = idx >= 0 ? rows[idx] : undefined;
    const next: SchemaJoinEntry = {
      key,
      datasource: datasource.name,
      env,
      service,
      kind: datasource.kind,
      database,
      leftTable: leftBare,
      rightTable: rightBare,
      directionHint: j.directionHint,
      conditionRaw: j.conditionRaw,
      conditionNormalized: j.conditionNormalized,
      firstSeenAt: prev?.firstSeenAt || input.now,
      lastSeenAt: input.now,
      sightings: (prev?.sightings || 0) + 1,
      confidence: Math.min(
        1,
        Math.max(0.4, (prev?.confidence || input.schemaConfidence) + 0.03),
      ),
      sources: Array.from(
        new Set([...(prev?.sources || []), 'observed-query']),
      ).sort() as SchemaProvenance[],
    };
    if (idx >= 0) rows[idx] = next;
    else rows.push(next);
  }
  return rows;
}

export function upsertJoinsFromRefresh(
  rows: SchemaJoinEntry[],
  input: {
    datasource: DatasourceProfile;
    source: SchemaProvenance;
    joins: {
      leftTable: string;
      rightTable: string;
      directionHint: 'left-to-right' | 'right-to-left' | 'unknown';
      conditionRaw: string;
      conditionNormalized: string;
    }[];
    now: string;
  },
): SchemaJoinEntry[] {
  const datasource = input.datasource;
  const env = str(datasource.env);
  const service = str(datasource.service);
  const database = str(datasource.connection.database);
  for (const item of input.joins) {
    const key = [service, item.leftTable, item.rightTable, item.conditionNormalized].join('|');
    const idx = rows.findIndex((row) => row.key === key);
    const prev = idx >= 0 ? rows[idx] : undefined;
    const next: SchemaJoinEntry = {
      key,
      datasource: datasource.name,
      env,
      service,
      kind: datasource.kind,
      database,
      leftTable: item.leftTable,
      rightTable: item.rightTable,
      directionHint: item.directionHint,
      conditionRaw: item.conditionRaw,
      conditionNormalized: item.conditionNormalized,
      firstSeenAt: prev?.firstSeenAt || input.now,
      lastSeenAt: input.now,
      sightings: (prev?.sightings || 0) + 1,
      confidence: Math.min(1, Math.max(0.6, prev?.confidence || 0.85)),
      sources: Array.from(
        new Set([...(prev?.sources || []), input.source]),
      ).sort() as SchemaProvenance[],
    };
    if (idx >= 0) rows[idx] = next;
    else rows.push(next);
  }
  return rows;
}

export function compactJoins(rows: SchemaJoinEntry[]): SchemaJoinEntry[] {
  return pickBestByKey(
    rows,
    (a, b) => a.sightings > b.sightings || a.lastSeenAt > b.lastSeenAt,
  );
}

export function pruneJoins(rows: SchemaJoinEntry[], cutoffMs: number): SchemaJoinEntry[] {
  return rows.filter((r) => new Date(r.lastSeenAt).getTime() >= cutoffMs);
}
