import fs from 'node:fs';
import path from 'node:path';
import type { DatasourceProfile, QueryResult, SchemaIndex, SchemaPartition } from '../types/core.js';
import { nowIso } from '../core/time.js';
import { readJsonFile, writeJsonFile } from '../core/json.js';
import { extractQueryShape, type ColumnRole } from '../core/schema-learning.js';
import type { RefreshedSchemaJoin, RefreshedSchemaTable } from '../core/schema-refresh.js';
import type { SchemaProvenance } from '../types/core.js';

export const SCHEMA_METADATA_VERSION = 2;

interface ResolutionEntry {
  key: string;
  env: string;
  namespace?: string;
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
  source: 'learned' | 'kb' | 'manual';
  lastVerifiedAt: string;
  successCount: number;
}

interface TargetSelectionEntry {
  key: string;
  env: string;
  namespace?: string;
  service: string;
  intentKey: string;
  engine: string;
  target: string;
  database: string;
  updatedAt: string;
  source: 'learned' | 'kb' | 'manual';
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

export interface SchemaTableColumnStat {
  column: string;
  selectedCount: number;
  filterCount: number;
  groupCount: number;
  orderCount: number;
  lastSeenAt: string;
}

export interface SchemaObservationEntry {
  key: string;
  metadataVersion?: number;
  datasource: string;
  env: string;
  service: string;
  kind: string;
  database: string;
  target: string;
  table: string;
  aliases: string[];
  columns: SchemaTableColumnStat[];
  primaryKey?: string[];
  indexes?: SchemaIndex[];
  partition?: SchemaPartition;
  firstSeenAt: string;
  lastSeenAt: string;
  sightings: number;
  confidence: number;
  sources: SchemaProvenance[];
}

export function schemaObservationHasCurrentMetadata(row: SchemaObservationEntry): boolean {
  return (
    row.metadataVersion === SCHEMA_METADATA_VERSION &&
    Array.isArray(row.indexes) &&
    row.columns.length > 0 &&
    (row.sources.includes('refreshed-metadata') || row.sources.includes('manual'))
  );
}

export interface SchemaJoinEntry {
  key: string;
  datasource: string;
  env: string;
  service: string;
  kind: string;
  database: string;
  leftTable: string;
  rightTable: string;
  directionHint: 'left-to-right' | 'right-to-left' | 'unknown';
  conditionRaw: string;
  conditionNormalized: string;
  firstSeenAt: string;
  lastSeenAt: string;
  sightings: number;
  confidence: number;
  sources: SchemaProvenance[];
}

export interface SchemaQueryShapeEntry {
  key: string;
  datasource: string;
  env: string;
  service: string;
  kind: string;
  database: string;
  operation: string;
  normalizedSql: string;
  tables: string[];
  joins: string[];
  firstSeenAt: string;
  lastSeenAt: string;
  sightings: number;
  confidence: number;
  sources: SchemaProvenance[];
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
  private readonly targetSelectionFile: string;
  private readonly schemaObservationFile: string;
  private readonly schemaJoinFile: string;
  private readonly schemaShapeFile: string;

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.resolutionFile = path.join(dir, 'resolution-cache.json');
    this.libraryFile = path.join(dir, 'query-library.json');
    this.statsFile = path.join(dir, 'query-stats.json');
    this.targetSelectionFile = path.join(dir, 'target-selections.json');
    this.schemaObservationFile = path.join(dir, 'schema-observations.json');
    this.schemaJoinFile = path.join(dir, 'schema-joins.json');
    this.schemaShapeFile = path.join(dir, 'schema-query-shapes.json');
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

  private loadTargetSelections(): TargetSelectionEntry[] {
    return readJsonFile<TargetSelectionEntry[]>(this.targetSelectionFile, []);
  }

  private loadSchemaObservations(): SchemaObservationEntry[] {
    return readJsonFile<SchemaObservationEntry[]>(this.schemaObservationFile, []);
  }

  private loadSchemaJoins(): SchemaJoinEntry[] {
    return readJsonFile<SchemaJoinEntry[]>(this.schemaJoinFile, []);
  }

  private loadSchemaShapes(): SchemaQueryShapeEntry[] {
    return readJsonFile<SchemaQueryShapeEntry[]>(this.schemaShapeFile, []);
  }

  private saveAll(input: {
    resolution?: ResolutionEntry[];
    library?: QueryLibraryEntry[];
    stats?: QueryStatEntry[];
    targetSelections?: TargetSelectionEntry[];
    schemaObservations?: SchemaObservationEntry[];
    schemaJoins?: SchemaJoinEntry[];
    schemaShapes?: SchemaQueryShapeEntry[];
  }): void {
    if (input.resolution) writeJsonFile(this.resolutionFile, input.resolution);
    if (input.library) writeJsonFile(this.libraryFile, input.library);
    if (input.stats) writeJsonFile(this.statsFile, input.stats);
    if (input.targetSelections) writeJsonFile(this.targetSelectionFile, input.targetSelections);
    if (input.schemaObservations) writeJsonFile(this.schemaObservationFile, input.schemaObservations);
    if (input.schemaJoins) writeJsonFile(this.schemaJoinFile, input.schemaJoins);
    if (input.schemaShapes) writeJsonFile(this.schemaShapeFile, input.schemaShapes);
  }

  private upsertColumnStat(columns: SchemaTableColumnStat[], column: string, role: ColumnRole, now: string): SchemaTableColumnStat[] {
    const idx = columns.findIndex((c) => c.column === column);
    const prev = idx >= 0
      ? columns[idx]
      : { column, selectedCount: 0, filterCount: 0, groupCount: 0, orderCount: 0, lastSeenAt: now };
    const next: SchemaTableColumnStat = {
      ...prev,
      lastSeenAt: now,
      selectedCount: prev.selectedCount + (role === 'select' ? 1 : 0),
      filterCount: prev.filterCount + (role === 'filter' ? 1 : 0),
      groupCount: prev.groupCount + (role === 'group' ? 1 : 0),
      orderCount: prev.orderCount + (role === 'order' ? 1 : 0),
    };
    if (idx >= 0) columns[idx] = next;
    else columns.push(next);
    return columns;
  }

  private observeSchema(input: { datasource: DatasourceProfile; sql: string; now: string }): void {
    const schema = extractQueryShape(input.sql);
    const observations = this.loadSchemaObservations();
    const joins = this.loadSchemaJoins();
    const shapes = this.loadSchemaShapes();
    const datasource = input.datasource;
    const env = String(datasource.env || '');
    const service = String(datasource.service || '');
    const database = String(datasource.connection.database || '');
    const target = String(datasource.connection.target || '');

    const aliasesByTable = new Map<string, string[]>();
    for (const t of schema.tables) {
      const key = t.table;
      if (!aliasesByTable.has(key)) aliasesByTable.set(key, []);
      if (t.alias && !aliasesByTable.get(key)?.includes(t.alias)) aliasesByTable.get(key)?.push(t.alias);
    }

    const columnTableFallback = schema.tables.length === 1 ? schema.tables[0].table : '';
    for (const [table, aliases] of aliasesByTable.entries()) {
      const key = [datasource.name, database, table].join('|');
      const idx = observations.findIndex((o) => o.key === key);
      const prev = idx >= 0 ? observations[idx] : undefined;
      const nextColumns = [...(prev?.columns || [])];
      for (const c of schema.columns) {
        const colTable = c.table || columnTableFallback;
        if (!colTable || colTable !== table) continue;
        this.upsertColumnStat(nextColumns, c.column, c.role, input.now);
      }
      const next: SchemaObservationEntry = {
        key,
        metadataVersion: prev?.metadataVersion,
        datasource: datasource.name,
        env,
        service,
        kind: datasource.kind,
        database,
        target,
        table,
        aliases: Array.from(new Set([...(prev?.aliases || []), ...aliases])).sort(),
        columns: nextColumns.sort((a, b) => a.column.localeCompare(b.column)),
        primaryKey: prev?.primaryKey,
        indexes: prev?.indexes,
        partition: prev?.partition,
        firstSeenAt: prev?.firstSeenAt || input.now,
        lastSeenAt: input.now,
        sightings: (prev?.sightings || 0) + 1,
        confidence: Math.min(1, Math.max(0.35, (prev?.confidence || 0.65) + 0.03)),
        sources: Array.from(new Set([...(prev?.sources || []), 'observed-query'])).sort() as SchemaProvenance[],
      };
      if (idx >= 0) observations[idx] = next;
      else observations.push(next);
    }

    for (const j of schema.joins) {
      const key = [datasource.name, database, j.leftTable, j.rightTable, j.conditionNormalized].join('|');
      const idx = joins.findIndex((o) => o.key === key);
      const prev = idx >= 0 ? joins[idx] : undefined;
      const next: SchemaJoinEntry = {
        key,
        datasource: datasource.name,
        env,
        service,
        kind: datasource.kind,
        database,
        leftTable: j.leftTable,
        rightTable: j.rightTable,
        directionHint: j.directionHint,
        conditionRaw: j.conditionRaw,
        conditionNormalized: j.conditionNormalized,
        firstSeenAt: prev?.firstSeenAt || input.now,
        lastSeenAt: input.now,
        sightings: (prev?.sightings || 0) + 1,
        confidence: Math.min(1, Math.max(0.4, (prev?.confidence || schema.confidence) + 0.03)),
        sources: Array.from(new Set([...(prev?.sources || []), 'observed-query'])).sort() as SchemaProvenance[],
      };
      if (idx >= 0) joins[idx] = next;
      else joins.push(next);
    }

    const shapeKey = [datasource.name, database, schema.operation, schema.normalizedSql].join('|');
    const shapeIdx = shapes.findIndex((o) => o.key === shapeKey);
    const prevShape = shapeIdx >= 0 ? shapes[shapeIdx] : undefined;
    const nextShape: SchemaQueryShapeEntry = {
      key: shapeKey,
      datasource: datasource.name,
      env,
      service,
      kind: datasource.kind,
      database,
      operation: schema.operation,
      normalizedSql: schema.normalizedSql,
      tables: Array.from(new Set(schema.tables.map((t) => t.table))).sort(),
      joins: Array.from(new Set(schema.joins.map((j) => `${j.leftTable}->${j.rightTable}`))).sort(),
      firstSeenAt: prevShape?.firstSeenAt || input.now,
      lastSeenAt: input.now,
      sightings: (prevShape?.sightings || 0) + 1,
      confidence: Math.min(1, Math.max(0.35, (prevShape?.confidence || schema.confidence) + 0.02)),
      sources: Array.from(new Set([...(prevShape?.sources || []), 'observed-query'])).sort() as SchemaProvenance[],
    };
    if (shapeIdx >= 0) shapes[shapeIdx] = nextShape;
    else shapes.push(nextShape);

    this.saveAll({
      schemaObservations: observations,
      schemaJoins: joins,
      schemaShapes: shapes,
    });
  }

  schemaTables(datasourceName?: string): SchemaObservationEntry[] {
    const rows = this.loadSchemaObservations();
    if (!datasourceName) return rows;
    return rows.filter((r) => r.datasource === datasourceName);
  }

  schemaJoins(datasourceName?: string): SchemaJoinEntry[] {
    const rows = this.loadSchemaJoins();
    if (!datasourceName) return rows;
    return rows.filter((r) => r.datasource === datasourceName);
  }

  schemaQueryShapes(datasourceName?: string): SchemaQueryShapeEntry[] {
    const rows = this.loadSchemaShapes();
    if (!datasourceName) return rows;
    return rows.filter((r) => r.datasource === datasourceName);
  }

  saveSchemaRefresh(input: {
    datasource: DatasourceProfile;
    source: SchemaProvenance;
    tables: RefreshedSchemaTable[];
    joins: RefreshedSchemaJoin[];
  }): void {
    const now = nowIso();
    const observations = this.loadSchemaObservations();
    const joins = this.loadSchemaJoins();
    const shapes = this.loadSchemaShapes();
    const datasource = input.datasource;
    const env = String(datasource.env || '');
    const service = String(datasource.service || '');
    const database = String(datasource.connection.database || '');
    const target = String(datasource.connection.target || '');

    for (const table of input.tables) {
      const key = [datasource.name, database, table.table].join('|');
      const idx = observations.findIndex((row) => row.key === key);
      const prev = idx >= 0 ? observations[idx] : undefined;
      const nextColumns = table.columns.map((column) => {
        const existing = prev?.columns.find((item) => item.column === column);
        return {
          column,
          selectedCount: existing?.selectedCount || 0,
          filterCount: existing?.filterCount || 0,
          groupCount: existing?.groupCount || 0,
          orderCount: existing?.orderCount || 0,
          lastSeenAt: now,
        };
      });
      const next: SchemaObservationEntry = {
        key,
        metadataVersion: table.metadataVersion || SCHEMA_METADATA_VERSION,
        datasource: datasource.name,
        env,
        service,
        kind: datasource.kind,
        database,
        target,
        table: table.table,
        aliases: prev?.aliases || [],
        columns: nextColumns,
        primaryKey: table.primaryKey || prev?.primaryKey || [],
        indexes: table.indexes || prev?.indexes || [],
        partition: table.partition || prev?.partition,
        firstSeenAt: prev?.firstSeenAt || now,
        lastSeenAt: now,
        sightings: (prev?.sightings || 0) + 1,
        confidence: Math.min(1, Math.max(0.55, prev?.confidence || 0.8)),
        sources: Array.from(new Set([...(prev?.sources || []), input.source])).sort() as SchemaProvenance[],
      };
      if (idx >= 0) observations[idx] = next;
      else observations.push(next);
    }

    for (const item of input.joins) {
      const key = [datasource.name, database, item.leftTable, item.rightTable, item.conditionNormalized].join('|');
      const idx = joins.findIndex((row) => row.key === key);
      const prev = idx >= 0 ? joins[idx] : undefined;
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
        firstSeenAt: prev?.firstSeenAt || now,
        lastSeenAt: now,
        sightings: (prev?.sightings || 0) + 1,
        confidence: Math.min(1, Math.max(0.6, prev?.confidence || 0.85)),
        sources: Array.from(new Set([...(prev?.sources || []), input.source])).sort() as SchemaProvenance[],
      };
      if (idx >= 0) joins[idx] = next;
      else joins.push(next);
    }

    const shapeKey = [datasource.name, database, 'metadata-refresh', input.tables.map((t) => t.table).sort().join(',')].join('|');
    const shapeIdx = shapes.findIndex((row) => row.key === shapeKey);
    const prevShape = shapeIdx >= 0 ? shapes[shapeIdx] : undefined;
    const nextShape: SchemaQueryShapeEntry = {
      key: shapeKey,
      datasource: datasource.name,
      env,
      service,
      kind: datasource.kind,
      database,
      operation: 'metadata-refresh',
      normalizedSql: `metadata-refresh:${input.tables.map((t) => t.table).sort().join(',')}`,
      tables: input.tables.map((t) => t.table).sort((a, b) => a.localeCompare(b)),
      joins: input.joins.map((j) => `${j.leftTable}->${j.rightTable}`).sort((a, b) => a.localeCompare(b)),
      firstSeenAt: prevShape?.firstSeenAt || now,
      lastSeenAt: now,
      sightings: (prevShape?.sightings || 0) + 1,
      confidence: Math.min(1, Math.max(0.55, prevShape?.confidence || 0.8)),
      sources: Array.from(new Set([...(prevShape?.sources || []), input.source])).sort() as SchemaProvenance[],
    };
    if (shapeIdx >= 0) shapes[shapeIdx] = nextShape;
    else shapes.push(nextShape);

    this.saveAll({
      schemaObservations: observations,
      schemaJoins: joins,
      schemaShapes: shapes,
    });
  }

  status(): { files: Record<string, number>; latest?: string } {
    const resolution = this.loadResolution();
    const library = this.loadLibrary();
    const stats = this.loadStats();
    const targetSelections = this.loadTargetSelections();
    const schemaObservations = this.loadSchemaObservations();
    const schemaJoins = this.loadSchemaJoins();
    const schemaShapes = this.loadSchemaShapes();
    const latest = [
      resolution.at(-1)?.lastVerifiedAt,
      library.at(-1)?.lastVerifiedAt,
      stats.at(-1)?.lastRunAt,
      targetSelections.at(-1)?.updatedAt,
      schemaObservations.at(-1)?.lastSeenAt,
      schemaJoins.at(-1)?.lastSeenAt,
      schemaShapes.at(-1)?.lastSeenAt,
    ]
      .filter(Boolean)
      .sort()
      .at(-1);
    return {
      files: {
        resolution: resolution.length,
        queryLibrary: library.length,
        queryStats: stats.length,
        targetSelections: targetSelections.length,
        schemaObservations: schemaObservations.length,
        schemaJoins: schemaJoins.length,
        schemaShapes: schemaShapes.length,
      },
      latest,
    };
  }

  resolveConnection(env: string, service: string, namespace?: string): ResolutionEntry | undefined {
    const key = namespace ? `${env}|${namespace}|${service}` : `${env}|${service}`;
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

  resolveTargetSelection(env: string, service: string, intent: string, namespace?: string): TargetSelectionEntry | undefined {
    const intentKey = normalizeIntent(intent);
    if (!intentKey) return undefined;
    return this.loadTargetSelections()
      .filter((row) => row.env === env && row.service === service && row.intentKey === intentKey && String(row.namespace || '') === String(namespace || ''))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  }

  saveTargetSelection(input: {
    env: string;
    namespace?: string;
    service: string;
    intent: string;
    engine: string;
    target: string;
    database: string;
    source?: 'learned' | 'kb' | 'manual';
  }): TargetSelectionEntry {
    const rows = this.loadTargetSelections();
    const env = String(input.env || '').trim();
    const namespace = String(input.namespace || '').trim();
    const service = String(input.service || '').trim();
    const intentKey = normalizeIntent(input.intent);
    const key = `${env}|${namespace}|${service}|${intentKey}`;
    const next: TargetSelectionEntry = {
      key,
      env,
      namespace: namespace || undefined,
      service,
      intentKey,
      engine: String(input.engine || '').trim(),
      target: String(input.target || '').trim(),
      database: String(input.database || '').trim(),
      updatedAt: nowIso(),
      source: input.source || 'manual',
    };
    const idx = rows.findIndex((row) => row.key === key);
    if (idx >= 0) rows[idx] = next;
    else rows.push(next);
    this.saveAll({ targetSelections: rows });
    return next;
  }

  saveQueryTemplate(input: {
    service: string;
    intent: string;
    sqlTemplate: string;
    source?: 'learned' | 'kb' | 'manual';
  }): QueryLibraryEntry {
    const library = this.loadLibrary();
    const service = String(input.service || '').trim();
    const intentKey = normalizeIntent(input.intent);
    const sqlTemplate = normalizeSqlTemplate(input.sqlTemplate);
    const key = `${service}|${intentKey}|${sqlTemplate}`;
    const id = stableId(key);
    const idx = library.findIndex((row) => row.key === key);
    const prev = idx >= 0 ? library[idx] : undefined;
    const next: QueryLibraryEntry = {
      id,
      key,
      service,
      intentKey,
      sqlTemplate,
      source: input.source || 'manual',
      lastVerifiedAt: nowIso(),
      successCount: prev?.successCount || 0,
    };
    if (idx >= 0) library[idx] = next;
    else library.push(next);
    this.saveAll({ library });
    return next;
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
    const namespace = String(input.datasource.namespace || '').trim();
    const service = String(input.datasource.service || '').trim();
    if (env && service) {
      const key = namespace ? `${env}|${namespace}|${service}` : `${env}|${service}`;
      const idx = resolution.findIndex((r) => r.key === key);
      const prev = idx >= 0 ? resolution[idx] : undefined;
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
        lastVerifiedAt: now,
        successCount: (prev?.successCount || 0) + 1,
        failureCount: prev?.failureCount || 0,
        confidence: Math.min(1, Math.max(0.4, (prev?.confidence ?? input.datasource.confidence ?? 0.8) + 0.02)),
      };
      if (idx >= 0) resolution[idx] = next;
      else resolution.push(next);
    }
    if (env && service && input.queryIntent && input.result.resolved?.target && input.result.resolved?.database) {
      this.saveTargetSelection({
        env,
        namespace: namespace || undefined,
        service,
        intent: input.queryIntent,
        engine: String(input.result.resolved.engine || input.datasource.kind || ''),
        target: String(input.result.resolved.target || ''),
        database: String(input.result.resolved.database || ''),
        source: 'learned',
      });
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

    this.observeSchema({ datasource: input.datasource, sql: input.sql, now });
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
    const targetSelections = this.loadTargetSelections();
    const now = nowIso();
    const env = String(input.datasource.env || '').trim();
    const namespace = String(input.datasource.namespace || '').trim();
    const service = String(input.datasource.service || '').trim();

    if (env && service) {
      const key = namespace ? `${env}|${namespace}|${service}` : `${env}|${service}`;
      const idx = resolution.findIndex((r) => r.key === key);
      if (idx >= 0) {
        resolution[idx] = {
          ...resolution[idx],
          namespace: namespace || undefined,
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
    const targetSelections = this.loadTargetSelections();
    const schemaObservations = this.loadSchemaObservations();
    const schemaJoins = this.loadSchemaJoins();
    const schemaShapes = this.loadSchemaShapes();
    const before =
      resolution.length + library.length + stats.length + targetSelections.length + schemaObservations.length + schemaJoins.length + schemaShapes.length;

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
    const targetSelectionMap = new Map<string, TargetSelectionEntry>();
    for (const row of targetSelections) {
      const cur = targetSelectionMap.get(row.key);
      if (!cur || row.updatedAt > cur.updatedAt) targetSelectionMap.set(row.key, row);
    }
    const schemaObservationMap = new Map<string, SchemaObservationEntry>();
    for (const row of schemaObservations) {
      const cur = schemaObservationMap.get(row.key);
      if (!cur || row.sightings > cur.sightings || row.lastSeenAt > cur.lastSeenAt) schemaObservationMap.set(row.key, row);
    }
    const schemaJoinMap = new Map<string, SchemaJoinEntry>();
    for (const row of schemaJoins) {
      const cur = schemaJoinMap.get(row.key);
      if (!cur || row.sightings > cur.sightings || row.lastSeenAt > cur.lastSeenAt) schemaJoinMap.set(row.key, row);
    }
    const schemaShapeMap = new Map<string, SchemaQueryShapeEntry>();
    for (const row of schemaShapes) {
      const cur = schemaShapeMap.get(row.key);
      if (!cur || row.sightings > cur.sightings || row.lastSeenAt > cur.lastSeenAt) schemaShapeMap.set(row.key, row);
    }
    const compactedSchemaObservations = [...schemaObservationMap.values()].sort((a, b) => a.key.localeCompare(b.key));
    const compactedSchemaJoins = [...schemaJoinMap.values()].sort((a, b) => a.key.localeCompare(b.key));
    const compactedSchemaShapes = [...schemaShapeMap.values()].sort((a, b) => a.key.localeCompare(b.key));
    const after =
      compactedResolution.length +
      compactedLibrary.length +
      compactedStats.length +
      targetSelectionMap.size +
      compactedSchemaObservations.length +
      compactedSchemaJoins.length +
      compactedSchemaShapes.length;
    this.saveAll({
      resolution: compactedResolution,
      library: compactedLibrary,
      stats: compactedStats,
      targetSelections: [...targetSelectionMap.values()].sort((a, b) => a.key.localeCompare(b.key)),
      schemaObservations: compactedSchemaObservations,
      schemaJoins: compactedSchemaJoins,
      schemaShapes: compactedSchemaShapes,
    });
    return { before, after };
  }

  prune(ttlHours: number): { before: number; after: number } {
    const resolution = this.loadResolution();
    const library = this.loadLibrary();
    const stats = this.loadStats();
    const targetSelections = this.loadTargetSelections();
    const schemaObservations = this.loadSchemaObservations();
    const schemaJoins = this.loadSchemaJoins();
    const schemaShapes = this.loadSchemaShapes();
    const cutoff = Date.now() - ttlHours * 3600 * 1000;
    const keepResolution = resolution.filter((r) => new Date(r.lastVerifiedAt).getTime() >= cutoff);
    const keepLibrary = library.filter((r) => new Date(r.lastVerifiedAt).getTime() >= cutoff);
    const keepStats = stats.filter((r) => new Date(r.lastRunAt).getTime() >= cutoff);
    const keepTargetSelections = targetSelections.filter((r) => new Date(r.updatedAt).getTime() >= cutoff);
    const keepSchemaObservations = schemaObservations.filter((r) => new Date(r.lastSeenAt).getTime() >= cutoff);
    const keepSchemaJoins = schemaJoins.filter((r) => new Date(r.lastSeenAt).getTime() >= cutoff);
    const keepSchemaShapes = schemaShapes.filter((r) => new Date(r.lastSeenAt).getTime() >= cutoff);
    this.saveAll({
      resolution: keepResolution,
      library: keepLibrary,
      stats: keepStats,
      targetSelections: keepTargetSelections,
      schemaObservations: keepSchemaObservations,
      schemaJoins: keepSchemaJoins,
      schemaShapes: keepSchemaShapes,
    });
    const before =
      resolution.length + library.length + stats.length + targetSelections.length + schemaObservations.length + schemaJoins.length + schemaShapes.length;
    const after =
      keepResolution.length +
      keepLibrary.length +
      keepStats.length +
      keepTargetSelections.length +
      keepSchemaObservations.length +
      keepSchemaJoins.length +
      keepSchemaShapes.length;
    return { before, after };
  }

  clear(): void {
    this.saveAll({ resolution: [], library: [], stats: [], targetSelections: [], schemaObservations: [], schemaJoins: [], schemaShapes: [] });
  }
}
