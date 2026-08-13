import type { DatasourceProfile } from '../types/core.js';
import { readJsonFile, writeJsonFile } from '../core/json.js';
import { str } from '../core/strings.js';
import type { SchemaCatalogEntry } from './learning-types.js';

export function loadSchemaCatalog(file: string): SchemaCatalogEntry[] {
  return readJsonFile<SchemaCatalogEntry[]>(file, []);
}

export function saveSchemaCatalog(file: string, rows: SchemaCatalogEntry[]): void {
  writeJsonFile(file, rows);
}

export function findCatalogEntry(rows: SchemaCatalogEntry[], datasourceName: string): SchemaCatalogEntry | undefined {
  const name = str(datasourceName).trim();
  if (!name) return undefined;
  return rows.find((row) => row.key === name);
}

export function upsertCatalogEntry(
  rows: SchemaCatalogEntry[],
  input: { datasource: DatasourceProfile; tableCount: number; now: string },
): SchemaCatalogEntry {
  const key = str(input.datasource.name).trim();
  const entry: SchemaCatalogEntry = {
    key,
    env: str(input.datasource.env),
    service: str(input.datasource.service),
    database: str(input.datasource.connection?.database),
    fetchedAt: input.now,
    tableCount: Math.max(0, Number(input.tableCount) || 0),
  };
  const index = rows.findIndex((row) => row.key === key);
  if (index >= 0) rows[index] = entry;
  else rows.push(entry);
  return entry;
}

export function compactCatalog(rows: SchemaCatalogEntry[]): SchemaCatalogEntry[] {
  const byKey = new Map<string, SchemaCatalogEntry>();
  for (const row of rows) {
    const current = byKey.get(row.key);
    if (!current || str(row.fetchedAt) > str(current.fetchedAt)) byKey.set(row.key, row);
  }
  return [...byKey.values()];
}

export function pruneCatalog(rows: SchemaCatalogEntry[], cutoffMs: number): SchemaCatalogEntry[] {
  return rows.filter((row) => Date.parse(str(row.fetchedAt)) >= cutoffMs);
}
