import { readJsonFile, writeJsonFile } from '../core/json.js';
import { str } from '../core/strings.js';
import { normalizeIntent, normalizeSqlTemplate, pickBestByKey, stableId } from './learning-utils.js';
import type { QueryLibraryEntry } from './learning-types.js';

export function loadLibrary(file: string): QueryLibraryEntry[] {
  return readJsonFile<QueryLibraryEntry[]>(file, []);
}

export function saveLibrary(file: string, rows: QueryLibraryEntry[]): void {
  writeJsonFile(file, rows);
}

export function libraryKey(service: string, intentKey: string, sqlTemplate: string): string {
  return `${service}|${intentKey}|${sqlTemplate}`;
}

export function resolveTemplateFromRows(
  rows: QueryLibraryEntry[],
  service: string,
  intent: string,
): QueryLibraryEntry | undefined {
  const intentKey = normalizeIntent(intent);
  if (!intentKey) return undefined;
  return rows
    .filter((q) => q.service === service && q.intentKey === intentKey)
    .sort(
      (a, b) =>
        b.successCount - a.successCount ||
        String(b.lastVerifiedAt).localeCompare(String(a.lastVerifiedAt)),
    )[0];
}

export function upsertQueryTemplate(
  rows: QueryLibraryEntry[],
  input: {
    service: string;
    intent: string;
    sqlTemplate: string;
    source?: 'learned' | 'kb' | 'manual';
    now: string;
  },
): QueryLibraryEntry {
  const service = str(input.service).trim();
  const intentKey = normalizeIntent(input.intent);
  const sqlTemplate = normalizeSqlTemplate(input.sqlTemplate);
  const key = libraryKey(service, intentKey, sqlTemplate);
  const id = stableId(key);
  const idx = rows.findIndex((row) => row.key === key);
  const prev = idx >= 0 ? rows[idx] : undefined;
  const next: QueryLibraryEntry = {
    id,
    key,
    service,
    intentKey,
    sqlTemplate,
    source: input.source || 'manual',
    lastVerifiedAt: input.now,
    successCount: prev?.successCount || 0,
  };
  if (idx >= 0) rows[idx] = next;
  else rows.push(next);
  return next;
}

export function recordLibrarySuccess(
  rows: QueryLibraryEntry[],
  input: { service: string; intent?: string; sql: string; now: string },
): QueryLibraryEntry | undefined {
  const service = str(input.service).trim();
  const intentKey = normalizeIntent(input.intent) || 'auto';
  const sqlTemplate = normalizeSqlTemplate(input.sql);
  if (!service || !sqlTemplate) return undefined;
  const key = libraryKey(service, intentKey, sqlTemplate);
  const id = stableId(key);
  const idx = rows.findIndex((q) => q.key === key);
  const prev = idx >= 0 ? rows[idx] : undefined;
  const next: QueryLibraryEntry = {
    id,
    key,
    service,
    intentKey,
    sqlTemplate,
    source: 'learned',
    lastVerifiedAt: input.now,
    successCount: (prev?.successCount || 0) + 1,
  };
  if (idx >= 0) rows[idx] = next;
  else rows.push(next);
  return next;
}

export function compactLibrary(rows: QueryLibraryEntry[]): QueryLibraryEntry[] {
  return pickBestByKey(
    rows,
    (a, b) => a.successCount > b.successCount || a.lastVerifiedAt > b.lastVerifiedAt,
  );
}

export function pruneLibrary(rows: QueryLibraryEntry[], cutoffMs: number): QueryLibraryEntry[] {
  return rows.filter((r) => new Date(r.lastVerifiedAt).getTime() >= cutoffMs);
}
