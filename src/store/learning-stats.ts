import { readJsonFile, writeJsonFile } from '../core/json.js';
import { median, pickBestByKey } from './learning-utils.js';
import type { QueryStatEntry } from './learning-types.js';

export function loadStats(file: string): QueryStatEntry[] {
  return readJsonFile<QueryStatEntry[]>(file, []);
}

export function saveStats(file: string, rows: QueryStatEntry[]): void {
  writeJsonFile(file, rows);
}

export function statKey(datasourceName: string, templateId: string): string {
  return `${datasourceName}|${templateId}`;
}

export function recordStatSuccess(
  rows: QueryStatEntry[],
  input: { datasourceName: string; templateId: string; durationMs: number; now: string },
): QueryStatEntry {
  const key = statKey(input.datasourceName, input.templateId);
  const idx = rows.findIndex((s) => s.key === key);
  const prev = idx >= 0 ? rows[idx] : undefined;
  const latencyHistory = [prev?.latencyMsP50 || input.durationMs, input.durationMs];
  const next: QueryStatEntry = {
    key,
    datasource: input.datasourceName,
    templateId: input.templateId,
    lastRunAt: input.now,
    lastStatus: 'success',
    successCount: (prev?.successCount || 0) + 1,
    failureCount: prev?.failureCount || 0,
    latencyMsP50: median(latencyHistory),
  };
  if (idx >= 0) rows[idx] = next;
  else rows.push(next);
  return next;
}

export function recordStatFailure(
  rows: QueryStatEntry[],
  input: {
    datasourceName: string;
    templateId: string;
    errorClass: string;
    durationMs?: number;
    now: string;
  },
): QueryStatEntry {
  const key = statKey(input.datasourceName, input.templateId);
  const idx = rows.findIndex((s) => s.key === key);
  const prev = idx >= 0 ? rows[idx] : undefined;
  const next: QueryStatEntry = {
    key,
    datasource: input.datasourceName,
    templateId: input.templateId,
    lastRunAt: input.now,
    lastStatus: 'error',
    lastErrorClass: input.errorClass,
    successCount: prev?.successCount || 0,
    failureCount: (prev?.failureCount || 0) + 1,
    latencyMsP50: prev?.latencyMsP50 || Math.max(0, Number(input.durationMs || 0)),
  };
  if (idx >= 0) rows[idx] = next;
  else rows.push(next);
  return next;
}

export function compactStats(rows: QueryStatEntry[]): QueryStatEntry[] {
  return pickBestByKey(rows, (a, b) => a.lastRunAt > b.lastRunAt);
}

export function pruneStats(rows: QueryStatEntry[], cutoffMs: number): QueryStatEntry[] {
  return rows.filter((r) => new Date(r.lastRunAt).getTime() >= cutoffMs);
}
