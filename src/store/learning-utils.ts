import { str } from '../core/strings.js';
import type { SchemaObservationEntry } from './learning-types.js';

export const SCHEMA_METADATA_VERSION = 2;

export function bareTableName(value: unknown): string {
  return str(value).replace(/`/g, '').trim().split('.').pop() || '';
}

export function isSystemTable(value: unknown): boolean {
  const lower = str(value).toLowerCase();
  return (
    lower.startsWith('information_schema.') ||
    lower.startsWith('performance_schema.') ||
    lower.startsWith('mysql.') ||
    lower === 'information_schema' ||
    lower === 'performance_schema' ||
    lower === 'mysql'
  );
}

export function pickBestByKey<T extends { key: string }>(rows: T[], isBetter: (candidate: T, current: T) => boolean): T[] {
  const map = new Map<string, T>();
  for (const row of rows) {
    const cur = map.get(row.key);
    if (!cur || isBetter(row, cur)) map.set(row.key, row);
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

export function schemaObservationHasCurrentMetadata(row: SchemaObservationEntry): boolean {
  return (
    row.metadataVersion === SCHEMA_METADATA_VERSION &&
    Array.isArray(row.indexes) &&
    row.columns.length > 0 &&
    (row.sources.includes('refreshed-metadata') || row.sources.includes('manual'))
  );
}
