import type { DatasourceProfile } from '../types/core.js';
import { readJsonFile, writeJsonFile } from '../core/json.js';
import { str } from '../core/strings.js';
import { pickBestByKey } from './learning-utils.js';
import type { ResolutionEntry } from './learning-types.js';

export function loadResolution(file: string): ResolutionEntry[] {
  return readJsonFile<ResolutionEntry[]>(file, []);
}

export function saveResolution(file: string, rows: ResolutionEntry[]): void {
  writeJsonFile(file, rows);
}

export function resolutionKey(env: string, service: string, namespace?: string): string {
  return namespace ? `${env}|${namespace}|${service}` : `${env}|${service}`;
}

export function resolveConnectionFromRows(
  rows: ResolutionEntry[],
  env: string,
  service: string,
  namespace?: string,
): ResolutionEntry | undefined {
  const key = resolutionKey(env, service, namespace);
  return rows
    .filter((r) => r.key === key)
    .sort(
      (a, b) =>
        b.confidence - a.confidence ||
        String(b.lastVerifiedAt).localeCompare(String(a.lastVerifiedAt)),
    )[0];
}

export function upsertResolutionSuccess(
  rows: ResolutionEntry[],
  input: { datasource: DatasourceProfile; now: string },
): ResolutionEntry[] {
  const env = str(input.datasource.env).trim();
  const namespace = str(input.datasource.namespace).trim();
  const service = str(input.datasource.service).trim();
  if (!env || !service) return rows;
  const key = resolutionKey(env, service, namespace || undefined);
  const idx = rows.findIndex((r) => r.key === key);
  const prev = idx >= 0 ? rows[idx] : undefined;
  const next: ResolutionEntry = {
    key,
    env,
    namespace: namespace || undefined,
    service,
    datasourceName: input.datasource.name,
    kind: input.datasource.kind,
    connection: input.datasource.connection,
    credentialRef: input.datasource.credentialRef,
    connectors: input.datasource.connectors || [],
    resolverHints: input.datasource.resolverHints || {},
    lastVerifiedAt: input.now,
    successCount: (prev?.successCount || 0) + 1,
    failureCount: prev?.failureCount || 0,
    confidence: Math.min(
      1,
      Math.max(0.4, (prev?.confidence ?? input.datasource.confidence ?? 0.8) + 0.02),
    ),
  };
  if (idx >= 0) rows[idx] = next;
  else rows.push(next);
  return rows;
}

export function applyResolutionFailure(
  rows: ResolutionEntry[],
  input: { datasource: DatasourceProfile; now: string },
): ResolutionEntry[] {
  const env = str(input.datasource.env).trim();
  const namespace = str(input.datasource.namespace).trim();
  const service = str(input.datasource.service).trim();
  if (!env || !service) return rows;
  const key = resolutionKey(env, service, namespace || undefined);
  const idx = rows.findIndex((r) => r.key === key);
  if (idx < 0) return rows;
  rows[idx] = {
    ...rows[idx],
    namespace: namespace || undefined,
    lastVerifiedAt: input.now,
    failureCount: rows[idx].failureCount + 1,
    confidence: Math.max(0.1, rows[idx].confidence - 0.05),
  };
  return rows;
}

export function compactResolution(rows: ResolutionEntry[]): ResolutionEntry[] {
  return pickBestByKey(
    rows,
    (a, b) => a.confidence > b.confidence || a.lastVerifiedAt > b.lastVerifiedAt,
  );
}

export function pruneResolution(rows: ResolutionEntry[], cutoffMs: number): ResolutionEntry[] {
  return rows.filter((r) => new Date(r.lastVerifiedAt).getTime() >= cutoffMs);
}
