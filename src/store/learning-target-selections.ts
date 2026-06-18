import { readJsonFile, writeJsonFile } from '../core/json.js';
import { str } from '../core/strings.js';
import { normalizeIntent, pickBestByKey } from './learning-utils.js';
import type { TargetSelectionEntry } from './learning-types.js';

export function loadTargetSelections(file: string): TargetSelectionEntry[] {
  return readJsonFile<TargetSelectionEntry[]>(file, []);
}

export function saveTargetSelections(file: string, rows: TargetSelectionEntry[]): void {
  writeJsonFile(file, rows);
}

export function targetSelectionKey(
  env: string,
  namespace: string,
  service: string,
  intentKey: string,
): string {
  return `${env}|${namespace}|${service}|${intentKey}`;
}

export function resolveTargetSelectionFromRows(
  rows: TargetSelectionEntry[],
  env: string,
  service: string,
  intent: string,
  namespace?: string,
): TargetSelectionEntry | undefined {
  const intentKey = normalizeIntent(intent);
  if (!intentKey) return undefined;
  return rows
    .filter(
      (row) =>
        row.env === env &&
        row.service === service &&
        row.intentKey === intentKey &&
        str(row.namespace) === str(namespace),
    )
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
}

export function upsertTargetSelection(
  rows: TargetSelectionEntry[],
  input: {
    env: string;
    namespace?: string;
    service: string;
    intent: string;
    engine: string;
    target: string;
    database: string;
    source?: 'learned' | 'kb' | 'manual';
    now: string;
  },
): TargetSelectionEntry {
  const env = str(input.env).trim();
  const namespace = str(input.namespace).trim();
  const service = str(input.service).trim();
  const intentKey = normalizeIntent(input.intent);
  const key = targetSelectionKey(env, namespace, service, intentKey);
  const next: TargetSelectionEntry = {
    key,
    env,
    namespace: namespace || undefined,
    service,
    intentKey,
    engine: str(input.engine).trim(),
    target: str(input.target).trim(),
    database: str(input.database).trim(),
    updatedAt: input.now,
    source: input.source || 'manual',
  };
  const idx = rows.findIndex((row) => row.key === key);
  if (idx >= 0) rows[idx] = next;
  else rows.push(next);
  return next;
}

export function compactTargetSelections(
  rows: TargetSelectionEntry[],
): TargetSelectionEntry[] {
  return pickBestByKey(rows, (a, b) => a.updatedAt > b.updatedAt);
}

export function pruneTargetSelections(
  rows: TargetSelectionEntry[],
  cutoffMs: number,
): TargetSelectionEntry[] {
  return rows.filter((r) => new Date(r.updatedAt).getTime() >= cutoffMs);
}
