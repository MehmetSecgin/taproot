import fs from 'node:fs';
import path from 'node:path';
import type { DatasourceProfile, QueryResult } from '../types/core.js';
import { nowIso } from '../core/time.js';
import { readJsonFile, writeJsonFile } from '../core/json.js';

interface ResolutionEntry {
  key: string;
  env: string;
  service: string;
  datasourceName: string;
  kind: string;
  connection: DatasourceProfile['connection'];
  credentialRef: string;
  connectors: string[];
  resolverHints?: Record<string, string>;
  lastVerifiedAt: string;
  successCount: number;
  failureCount: number;
  confidence: number;
}

interface QueryLibraryEntry {
  id: string;
  key: string;
  service: string;
  intentKey: string;
  sqlTemplate: string;
  source: 'learned' | 'kb';
  lastVerifiedAt: string;
  successCount: number;
}

interface QueryStatEntry {
  key: string;
  datasource: string;
  templateId: string;
  lastRunAt: string;
  lastStatus: 'success' | 'error';
  lastErrorClass?: string;
  successCount: number;
  failureCount: number;
  latencyMsP50: number;
}

interface LegacyRecord {
  datasource: string;
  env?: string;
  service?: string;
  resolvedAt?: string;
  confidence?: number;
  queryIntent?: string;
  querySignature?: string;
}

function normalizeIntent(value?: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function normalizeSqlTemplate(sql: string): string {
  let out = sql.trim().replace(/\s+/g, ' ').toLowerCase();
  out = out.replace(/'(?:''|[^'])*'/g, ':str');
  out = out.replace(/\b\d+\.\d+\b/g, ':num');
  out = out.replace(/\b\d+\b/g, ':num');
  out = out.replace(/\b(true|false)\b/g, ':bool');
  out = out.replace(/\s+/g, ' ').trim();
  return out;
}

function stableId(value: string): string {
  let h = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return `q_${(h >>> 0).toString(16)}`;
}

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2) return sorted[mid];
  return Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

export class LearningStore {
  private readonly resolutionFile: string;
  private readonly libraryFile: string;
  private readonly statsFile: string;
  private readonly legacyFile: string;

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.resolutionFile = path.join(dir, 'resolution-cache.json');
    this.libraryFile = path.join(dir, 'query-library.json');
    this.statsFile = path.join(dir, 'query-stats.json');
    this.legacyFile = path.join(dir, 'records.json');
    this.migrateLegacy();
  }

  private loadResolution(): ResolutionEntry[] {
    return readJsonFile<ResolutionEntry[]>(this.resolutionFile, []);
  }

  private loadLibrary(): QueryLibraryEntry[] {
    return readJsonFile<QueryLibraryEntry[]>(this.libraryFile, []);
  }

  private loadStats(): QueryStatEntry[] {
    return readJsonFile<QueryStatEntry[]>(this.statsFile, []);
  }

  private saveAll(input: { resolution?: ResolutionEntry[]; library?: QueryLibraryEntry[]; stats?: QueryStatEntry[] }): void {
    if (input.resolution) writeJsonFile(this.resolutionFile, input.resolution);
    if (input.library) writeJsonFile(this.libraryFile, input.library);
    if (input.stats) writeJsonFile(this.statsFile, input.stats);
  }

  private migrateLegacy(): void {
    if (!fs.existsSync(this.legacyFile)) return;
    if (fs.existsSync(this.resolutionFile) || fs.existsSync(this.libraryFile) || fs.existsSync(this.statsFile)) return;
    const rows = readJsonFile<LegacyRecord[]>(this.legacyFile, []);
    if (!rows.length) return;
    const resolution = new Map<string, ResolutionEntry>();
    const library = new Map<string, QueryLibraryEntry>();
    for (const row of rows) {
      const env = String(row.env || '').trim();
      const service = String(row.service || '').trim();
      if (env && service) {
        const key = `${env}|${service}`;
        resolution.set(key, {
          key,
          env,
          service,
          datasourceName: String(row.datasource || `${env}-${service}`),
          kind: 'mysql',
          connection: {},
          credentialRef: `${env}:${service}`,
          connectors: [],
          resolverHints: {},
          lastVerifiedAt: String(row.resolvedAt || nowIso()),
          successCount: 1,
          failureCount: 0,
          confidence: Math.max(0, Math.min(1, Number(row.confidence ?? 0.8))),
        });
      }
      const sql = String(row.querySignature || '').trim();
      if (service && sql) {
        const intentKey = normalizeIntent(row.queryIntent) || 'auto';
        const sqlTemplate = normalizeSqlTemplate(sql);
        const key = `${service}|${intentKey}|${sqlTemplate}`;
        library.set(key, {
          id: stableId(key),
          key,
          service,
          intentKey,
          sqlTemplate,
          source: 'learned',
          lastVerifiedAt: String(row.resolvedAt || nowIso()),
          successCount: 1,
        });
      }
    }
    this.saveAll({
      resolution: [...resolution.values()],
      library: [...library.values()],
      stats: [],
    });
  }

  status(): { files: Record<string, number>; latest?: string } {
    const resolution = this.loadResolution();
    const library = this.loadLibrary();
    const stats = this.loadStats();
    const latest = [resolution.at(-1)?.lastVerifiedAt, library.at(-1)?.lastVerifiedAt, stats.at(-1)?.lastRunAt]
      .filter(Boolean)
      .sort()
      .at(-1);
    return {
      files: {
        resolution: resolution.length,
        queryLibrary: library.length,
        queryStats: stats.length,
      },
      latest,
    };
  }

  resolveConnection(env: string, service: string): ResolutionEntry | undefined {
    const key = `${env}|${service}`;
    return this.loadResolution()
      .filter((r) => r.key === key)
      .sort((a, b) => b.confidence - a.confidence || String(b.lastVerifiedAt).localeCompare(String(a.lastVerifiedAt)))[0];
  }

  resolveQueryTemplate(service: string, intent: string): QueryLibraryEntry | undefined {
    const intentKey = normalizeIntent(intent);
    if (!intentKey) return undefined;
    return this.loadLibrary()
      .filter((q) => q.service === service && q.intentKey === intentKey)
      .sort((a, b) => b.successCount - a.successCount || String(b.lastVerifiedAt).localeCompare(String(a.lastVerifiedAt)))[0];
  }

  saveSuccess(input: {
    datasource: DatasourceProfile;
    queryIntent?: string;
    sql: string;
    result: QueryResult;
  }): void {
    const resolution = this.loadResolution();
    const library = this.loadLibrary();
    const stats = this.loadStats();
    const now = nowIso();

    const env = String(input.datasource.env || '').trim();
    const service = String(input.datasource.service || '').trim();
    if (env && service) {
      const key = `${env}|${service}`;
      const idx = resolution.findIndex((r) => r.key === key);
      const prev = idx >= 0 ? resolution[idx] : undefined;
      const next: ResolutionEntry = {
        key,
        env,
        service,
        datasourceName: input.datasource.name,
        kind: input.datasource.kind,
        connection: input.datasource.connection,
        credentialRef: input.datasource.credentialRef,
        connectors: input.datasource.connectors || [],
        resolverHints: input.datasource.resolverHints || {},
        lastVerifiedAt: now,
        successCount: (prev?.successCount || 0) + 1,
        failureCount: prev?.failureCount || 0,
        confidence: Math.min(1, Math.max(0.4, (prev?.confidence ?? input.datasource.confidence ?? 0.8) + 0.02)),
      };
      if (idx >= 0) resolution[idx] = next;
      else resolution.push(next);
    }

    const intentKey = normalizeIntent(input.queryIntent) || 'auto';
    const sqlTemplate = normalizeSqlTemplate(input.sql);
    if (service && sqlTemplate) {
      const key = `${service}|${intentKey}|${sqlTemplate}`;
      const id = stableId(key);
      const libIdx = library.findIndex((q) => q.key === key);
      const prev = libIdx >= 0 ? library[libIdx] : undefined;
      const next: QueryLibraryEntry = {
        id,
        key,
        service,
        intentKey,
        sqlTemplate,
        source: 'learned',
        lastVerifiedAt: now,
        successCount: (prev?.successCount || 0) + 1,
      };
      if (libIdx >= 0) library[libIdx] = next;
      else library.push(next);

      const statKey = `${input.datasource.name}|${id}`;
      const statIdx = stats.findIndex((s) => s.key === statKey);
      const prevStat = statIdx >= 0 ? stats[statIdx] : undefined;
      const latencyHistory = [prevStat?.latencyMsP50 || input.result.timings.durationMs, input.result.timings.durationMs];
      const nextStat: QueryStatEntry = {
        key: statKey,
        datasource: input.datasource.name,
        templateId: id,
        lastRunAt: now,
        lastStatus: 'success',
        successCount: (prevStat?.successCount || 0) + 1,
        failureCount: prevStat?.failureCount || 0,
        latencyMsP50: median(latencyHistory),
      };
      if (statIdx >= 0) stats[statIdx] = nextStat;
      else stats.push(nextStat);
    }

    this.saveAll({ resolution, library, stats });
  }

  saveFailure(input: {
    datasource?: DatasourceProfile;
    queryIntent?: string;
    sql?: string;
    errorClass: string;
    durationMs?: number;
  }): void {
    if (!input.datasource) return;
    const resolution = this.loadResolution();
    const library = this.loadLibrary();
    const stats = this.loadStats();
    const now = nowIso();
    const env = String(input.datasource.env || '').trim();
    const service = String(input.datasource.service || '').trim();

    if (env && service) {
      const key = `${env}|${service}`;
      const idx = resolution.findIndex((r) => r.key === key);
      if (idx >= 0) {
        resolution[idx] = {
          ...resolution[idx],
          lastVerifiedAt: now,
          failureCount: resolution[idx].failureCount + 1,
          confidence: Math.max(0.1, resolution[idx].confidence - 0.05),
        };
      }
    }

    const sqlTemplate = input.sql ? normalizeSqlTemplate(input.sql) : '';
    const intentKey = normalizeIntent(input.queryIntent) || 'auto';
    const key = service && sqlTemplate ? `${service}|${intentKey}|${sqlTemplate}` : '';
    const templateId = key ? stableId(key) : '';
    if (templateId) {
      const statKey = `${input.datasource.name}|${templateId}`;
      const idx = stats.findIndex((s) => s.key === statKey);
      const prev = idx >= 0 ? stats[idx] : undefined;
      const next: QueryStatEntry = {
        key: statKey,
        datasource: input.datasource.name,
        templateId,
        lastRunAt: now,
        lastStatus: 'error',
        lastErrorClass: input.errorClass,
        successCount: prev?.successCount || 0,
        failureCount: (prev?.failureCount || 0) + 1,
        latencyMsP50: prev?.latencyMsP50 || Math.max(0, Number(input.durationMs || 0)),
      };
      if (idx >= 0) stats[idx] = next;
      else stats.push(next);
    }

    this.saveAll({ resolution, library, stats });
  }

  compact(): { before: number; after: number } {
    const resolution = this.loadResolution();
    const library = this.loadLibrary();
    const stats = this.loadStats();
    const before = resolution.length + library.length + stats.length;

    const resolutionMap = new Map<string, ResolutionEntry>();
    for (const row of resolution) {
      const cur = resolutionMap.get(row.key);
      if (!cur || row.confidence > cur.confidence || row.lastVerifiedAt > cur.lastVerifiedAt) resolutionMap.set(row.key, row);
    }
    const libraryMap = new Map<string, QueryLibraryEntry>();
    for (const row of library) {
      const cur = libraryMap.get(row.key);
      if (!cur || row.successCount > cur.successCount || row.lastVerifiedAt > cur.lastVerifiedAt) libraryMap.set(row.key, row);
    }
    const statMap = new Map<string, QueryStatEntry>();
    for (const row of stats) {
      const cur = statMap.get(row.key);
      if (!cur || row.lastRunAt > cur.lastRunAt) statMap.set(row.key, row);
    }

    const compactedResolution = [...resolutionMap.values()].sort((a, b) => a.key.localeCompare(b.key));
    const compactedLibrary = [...libraryMap.values()].sort((a, b) => a.key.localeCompare(b.key));
    const compactedStats = [...statMap.values()].sort((a, b) => a.key.localeCompare(b.key));
    const after = compactedResolution.length + compactedLibrary.length + compactedStats.length;
    this.saveAll({ resolution: compactedResolution, library: compactedLibrary, stats: compactedStats });
    return { before, after };
  }

  prune(ttlHours: number): { before: number; after: number } {
    const resolution = this.loadResolution();
    const library = this.loadLibrary();
    const stats = this.loadStats();
    const cutoff = Date.now() - ttlHours * 3600 * 1000;
    const keepResolution = resolution.filter((r) => new Date(r.lastVerifiedAt).getTime() >= cutoff);
    const keepLibrary = library.filter((r) => new Date(r.lastVerifiedAt).getTime() >= cutoff);
    const keepStats = stats.filter((r) => new Date(r.lastRunAt).getTime() >= cutoff);
    this.saveAll({ resolution: keepResolution, library: keepLibrary, stats: keepStats });
    const before = resolution.length + library.length + stats.length;
    const after = keepResolution.length + keepLibrary.length + keepStats.length;
    return { before, after };
  }

  clear(): void {
    this.saveAll({ resolution: [], library: [], stats: [] });
  }
}

