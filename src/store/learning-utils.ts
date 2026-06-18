import { str } from '../core/strings.js';
import type { SchemaObservationEntry } from './learning-types.js';

export const SCHEMA_METADATA_VERSION = 2;

export function bareTableName(value: unknown): string {
  return str(value).replace(/`/g, '').trim().split('.').pop() || '';
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

export function normalizeIntent(value?: string): string {
  return str(value)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

export function normalizeSqlTemplate(sql: string): string {
  let out = sql.trim().replace(/\s+/g, ' ').toLowerCase();
  out = out.replace(/'(?:''|[^'])*'/g, ':str');
  out = out.replace(/\b\d+\.\d+\b/g, ':num');
  out = out.replace(/\b\d+\b/g, ':num');
  out = out.replace(/\b(true|false)\b/g, ':bool');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

export function stableId(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return `q_${(h >>> 0).toString(16)}`;
}

export function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
