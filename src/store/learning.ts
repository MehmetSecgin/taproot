import fs from 'node:fs';
import path from 'node:path';
import type { DatasourceProfile, QueryResult, RpcEnumShape, RpcMessageShape, RpcServiceShape } from '../types/core.js';
import { nowIso } from '../core/time.js';
import { readJsonFile, writeJsonFile } from '../core/json.js';
import { extractQueryShape, type ColumnRole } from '../core/schema-learning.js';
import type { RefreshedSchemaJoin, RefreshedSchemaTable } from '../core/schema-refresh.js';
import type { SchemaProvenance } from '../types/core.js';
import { str } from '../core/strings.js';
import {
  SCHEMA_METADATA_VERSION,
  bareTableName,
  median,
  normalizeIntent,
  normalizeSqlTemplate,
  pickBestByKey,
  schemaObservationHasCurrentMetadata,
  stableId,
} from './learning-utils.js';
import type {
  GrpcServiceSchemaEntry,
  QueryLibraryEntry,
  QueryStatEntry,
  ResolutionEntry,
  SchemaJoinEntry,
  SchemaObservationEntry,
  SchemaQueryShapeEntry,
  SchemaTableColumnStat,
  TargetSelectionEntry,
} from './learning-types.js';

export { SCHEMA_METADATA_VERSION, bareTableName, schemaObservationHasCurrentMetadata } from './learning-utils.js';
export type {
  GrpcServiceSchemaEntry,
  QueryLibraryEntry,
  QueryStatEntry,
  ResolutionEntry,
  SchemaJoinEntry,
  SchemaObservationEntry,
  SchemaQueryShapeEntry,
  SchemaTableColumnStat,
  TargetSelectionEntry,
} from './learning-types.js';

export class LearningStore {
  private readonly resolutionFile: string;
  private readonly libraryFile: string;
  private readonly statsFile: string;
  private readonly targetSelectionFile: string;
  private readonly schemaObservationFile: string;
  private readonly schemaJoinFile: string;
  private readonly schemaShapeFile: string;
  private readonly grpcSchemaFile: string;
  private schemaKeysMigrated = false;

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.resolutionFile = path.join(dir, 'resolution-cache.json');
    this.libraryFile = path.join(dir, 'query-library.json');
    this.statsFile = path.join(dir, 'query-stats.json');
    this.targetSelectionFile = path.join(dir, 'target-selections.json');
    this.schemaObservationFile = path.join(dir, 'schema-observations.json');
    this.schemaJoinFile = path.join(dir, 'schema-joins.json');
    this.schemaShapeFile = path.join(dir, 'schema-query-shapes.json');
    this.grpcSchemaFile = path.join(dir, 'grpc-schemas.json');
  }

  private mergeColumnStats(a: SchemaTableColumnStat[], b: SchemaTableColumnStat[]): SchemaTableColumnStat[] {
    const map = new Map<string, SchemaTableColumnStat>();
    for (const stat of [...a, ...b]) {
      const prev = map.get(stat.column);
      if (!prev) {
        map.set(stat.column, { ...stat });
        continue;
      }
      map.set(stat.column, {
        column: stat.column,
        selectedCount: prev.selectedCount + stat.selectedCount,
        filterCount: prev.filterCount + stat.filterCount,
        groupCount: prev.groupCount + stat.groupCount,
        orderCount: prev.orderCount + stat.orderCount,
        lastSeenAt: prev.lastSeenAt > stat.lastSeenAt ? prev.lastSeenAt : stat.lastSeenAt,
      });
    }
    return [...map.values()].sort((x, y) => x.column.localeCompare(y.column));
  }

  private mergeObservation(existing: SchemaObservationEntry, incoming: SchemaObservationEntry, newKey: string): SchemaObservationEntry {
    const completePrev = schemaObservationHasCurrentMetadata(existing);
    const completeNext = schemaObservationHasCurrentMetadata(incoming);
    const winner = completeNext && !completePrev
      ? incoming
      : completePrev && !completeNext
        ? existing
        : Date.parse(incoming.lastSeenAt) >= Date.parse(existing.lastSeenAt)
          ? incoming
          : existing;
    return {
      ...winner,
      key: newKey,
      aliases: Array.from(new Set([...(existing.aliases || []), ...(incoming.aliases || [])])).sort(),
      columns: this.mergeColumnStats(existing.columns || [], incoming.columns || []),
      sightings: (existing.sightings || 0) + (incoming.sightings || 0),
      confidence: Math.max(existing.confidence || 0, incoming.confidence || 0),
      sources: Array.from(new Set([...(existing.sources || []), ...(incoming.sources || [])])).sort() as SchemaProvenance[],
      firstSeenAt: existing.firstSeenAt < incoming.firstSeenAt ? existing.firstSeenAt : incoming.firstSeenAt,
      lastSeenAt: existing.lastSeenAt > incoming.lastSeenAt ? existing.lastSeenAt : incoming.lastSeenAt,
    };
  }

  private migrateSchemaKeysIfNeeded(): void {
    if (this.schemaKeysMigrated) return;
    this.schemaKeysMigrated = true;

    const observations = readJsonFile<SchemaObservationEntry[]>(this.schemaObservationFile, []);
    if (observations.length) {
      const merged = new Map<string, SchemaObservationEntry>();
      let changed = false;
      for (const row of observations) {
        if (!row.service || !row.table) {
          if (!changed) changed = true;
          continue;
        }
        const tableLower = String(row.table).toLowerCase();
        if (tableLower.startsWith('information_schema.') || tableLower.startsWith('performance_schema.') || tableLower.startsWith('mysql.')) {
          changed = true;
          continue;
        }
        const bareTable = bareTableName(row.table);
        if (!bareTable) {
          changed = true;
          continue;
        }
        if (bareTable !== row.table) {
          changed = true;
          row.table = bareTable;
        }
        const newKey = `${row.service}|${row.table}`;
        if (row.key !== newKey) changed = true;
        const existing = merged.get(newKey);
        if (existing) {
          changed = true;
          merged.set(newKey, this.mergeObservation(existing, row, newKey));
        } else {
          merged.set(newKey, { ...row, key: newKey });
        }
      }
      if (changed) {
        const next = [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
        writeJsonFile(this.schemaObservationFile, next);
      }
    }

    const joins = readJsonFile<SchemaJoinEntry[]>(this.schemaJoinFile, []);
    if (joins.length) {
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
            sources: Array.from(new Set([...(existing.sources || []), ...(row.sources || [])])).sort() as SchemaProvenance[],
            firstSeenAt: existing.firstSeenAt < row.firstSeenAt ? existing.firstSeenAt : row.firstSeenAt,
            lastSeenAt: existing.lastSeenAt > row.lastSeenAt ? existing.lastSeenAt : row.lastSeenAt,
          });
        } else {
          merged.set(newKey, { ...row, key: newKey });
        }
      }
      if (changed) {
        const next = [...merged.values()].sort((a, b) => a.key.localeCompare(b.key));
        writeJsonFile(this.schemaJoinFile, next);
      }
    }
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
    this.migrateSchemaKeysIfNeeded();
    return readJsonFile<SchemaObservationEntry[]>(this.schemaObservationFile, []);
  }

  private loadSchemaJoins(): SchemaJoinEntry[] {
    this.migrateSchemaKeysIfNeeded();
    return readJsonFile<SchemaJoinEntry[]>(this.schemaJoinFile, []);
  }

  private loadSchemaShapes(): SchemaQueryShapeEntry[] {
    return readJsonFile<SchemaQueryShapeEntry[]>(this.schemaShapeFile, []);
  }

  private loadGrpcSchemas(): GrpcServiceSchemaEntry[] {
    return readJsonFile<GrpcServiceSchemaEntry[]>(this.grpcSchemaFile, []);
  }

  private saveAll(input: {
    resolution?: ResolutionEntry[];
    library?: QueryLibraryEntry[];
    stats?: QueryStatEntry[];
    targetSelections?: TargetSelectionEntry[];
    schemaObservations?: SchemaObservationEntry[];
    schemaJoins?: SchemaJoinEntry[];
    schemaShapes?: SchemaQueryShapeEntry[];
    grpcSchemas?: GrpcServiceSchemaEntry[];
  }): void {
    if (input.resolution) writeJsonFile(this.resolutionFile, input.resolution);
    if (input.library) writeJsonFile(this.libraryFile, input.library);
    if (input.stats) writeJsonFile(this.statsFile, input.stats);
    if (input.targetSelections) writeJsonFile(this.targetSelectionFile, input.targetSelections);
    if (input.schemaObservations) writeJsonFile(this.schemaObservationFile, input.schemaObservations);
    if (input.schemaJoins) writeJsonFile(this.schemaJoinFile, input.schemaJoins);
    if (input.schemaShapes) writeJsonFile(this.schemaShapeFile, input.schemaShapes);
    if (input.grpcSchemas) writeJsonFile(this.grpcSchemaFile, input.grpcSchemas);
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
    const schema = extractQueryShape(input.sql, { dialect: input.datasource.kind });
    const observations = this.loadSchemaObservations();
    const joins = this.loadSchemaJoins();
    const shapes = this.loadSchemaShapes();
    const datasource = input.datasource;
    const env = str(datasource.env);
    const service = str(datasource.service);
    const database = str(datasource.connection.database);
    const target = str(datasource.connection.target);

    const bare = bareTableName;
    const isSystemTable = (value: string): boolean => {
      const lower = str(value).toLowerCase();
      return lower.startsWith('information_schema.') || lower.startsWith('performance_schema.') || lower.startsWith('mysql.')
        || lower === 'information_schema' || lower === 'performance_schema' || lower === 'mysql';
    };
    const aliasesByTable = new Map<string, string[]>();
    for (const t of schema.tables) {
      if (isSystemTable(t.table)) continue;
      const baseTable = bare(t.table);
      if (!baseTable) continue;
      if (!aliasesByTable.has(baseTable)) aliasesByTable.set(baseTable, []);
      if (t.alias && !aliasesByTable.get(baseTable)?.includes(t.alias)) aliasesByTable.get(baseTable)?.push(t.alias);
    }

    const columnTableFallback = aliasesByTable.size === 1 ? [...aliasesByTable.keys()][0] : '';
    for (const [table, aliases] of aliasesByTable.entries()) {
      const key = [service, table].join('|');
      const idx = observations.findIndex((o) => o.key === key);
      const prev = idx >= 0 ? observations[idx] : undefined;
      const nextColumns = [...(prev?.columns || [])];
      for (const c of schema.columns) {
        const colTableRaw = c.table || columnTableFallback;
        const colTable = bare(colTableRaw);
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
      if (isSystemTable(j.leftTable) || isSystemTable(j.rightTable)) continue;
      const leftBare = bare(j.leftTable);
      const rightBare = bare(j.rightTable);
      if (!leftBare || !rightBare) continue;
      const key = [service, leftBare, rightBare, j.conditionNormalized].join('|');
      const idx = joins.findIndex((o) => o.key === key);
      const prev = idx >= 0 ? joins[idx] : undefined;
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

  schemaTables(service?: string): SchemaObservationEntry[] {
    const rows = this.loadSchemaObservations();
    if (!service) return rows;
    return rows.filter((r) => r.service === service);
  }

  schemaJoins(service?: string): SchemaJoinEntry[] {
    const rows = this.loadSchemaJoins();
    if (!service) return rows;
    return rows.filter((r) => r.service === service);
  }

  schemaQueryShapes(datasourceName?: string): SchemaQueryShapeEntry[] {
    const rows = this.loadSchemaShapes();
    if (!datasourceName) return rows;
    return rows.filter((r) => r.datasource === datasourceName);
  }

  grpcSchemas(service?: string): GrpcServiceSchemaEntry[] {
    const rows = this.loadGrpcSchemas();
    if (!service) return rows;
    return rows.filter((r) => r.service === service);
  }

  saveGrpcSchema(input: {
    datasource: DatasourceProfile;
    protoRoot: string;
    source?: SchemaProvenance;
    services: RpcServiceShape[];
    messages: Record<string, RpcMessageShape>;
    enums: Record<string, RpcEnumShape>;
  }): GrpcServiceSchemaEntry {
    const now = nowIso();
    const rows = this.loadGrpcSchemas();
    const datasource = input.datasource;
    const service = String(datasource.service || datasource.name);
    const key = service;
    const idx = rows.findIndex((r) => r.key === key);
    const prev = idx >= 0 ? rows[idx] : undefined;
    const entry: GrpcServiceSchemaEntry = {
      key,
      datasource: datasource.name,
      env: str(datasource.env),
      service,
      kind: datasource.kind,
      protoRoot: input.protoRoot,
      services: input.services,
      messages: input.messages,
      enums: input.enums,
      firstSeenAt: prev?.firstSeenAt || now,
      lastSeenAt: now,
      sources: Array.from(new Set([...(prev?.sources || []), input.source || 'refreshed-metadata'])).sort() as SchemaProvenance[],
    };
    if (idx >= 0) rows[idx] = entry;
    else rows.push(entry);
    this.saveAll({ grpcSchemas: rows });
    return entry;
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
    const env = str(datasource.env);
    const service = str(datasource.service);
    const database = str(datasource.connection.database);
    const target = str(datasource.connection.target);

    for (const table of input.tables) {
      const key = [service, table.table].join('|');
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
      const key = [service, item.leftTable, item.rightTable, item.conditionNormalized].join('|');
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
    const grpcSchemas = this.loadGrpcSchemas();
    const latest = [
      resolution.at(-1)?.lastVerifiedAt,
      library.at(-1)?.lastVerifiedAt,
      stats.at(-1)?.lastRunAt,
      targetSelections.at(-1)?.updatedAt,
      schemaObservations.at(-1)?.lastSeenAt,
      schemaJoins.at(-1)?.lastSeenAt,
      schemaShapes.at(-1)?.lastSeenAt,
      grpcSchemas.at(-1)?.lastSeenAt,
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
        grpcSchemas: grpcSchemas.length,
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
      .filter((row) => row.env === env && row.service === service && row.intentKey === intentKey && str(row.namespace) === str(namespace))
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
    const env = str(input.env).trim();
    const namespace = str(input.namespace).trim();
    const service = str(input.service).trim();
    const intentKey = normalizeIntent(input.intent);
    const key = `${env}|${namespace}|${service}|${intentKey}`;
    const next: TargetSelectionEntry = {
      key,
      env,
      namespace: namespace || undefined,
      service,
      intentKey,
      engine: str(input.engine).trim(),
      target: str(input.target).trim(),
      database: str(input.database).trim(),
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
    const service = str(input.service).trim();
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

    const env = str(input.datasource.env).trim();
    const namespace = str(input.datasource.namespace).trim();
    const service = str(input.datasource.service).trim();
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
        engine: str(input.result.resolved.engine || input.datasource.kind),
        target: str(input.result.resolved.target),
        database: str(input.result.resolved.database),
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
    const env = str(input.datasource.env).trim();
    const namespace = str(input.datasource.namespace).trim();
    const service = str(input.datasource.service).trim();

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
    const grpcSchemas = this.loadGrpcSchemas();
    const before =
      resolution.length + library.length + stats.length + targetSelections.length + schemaObservations.length + schemaJoins.length + schemaShapes.length + grpcSchemas.length;

    const compactedResolution = pickBestByKey(resolution, (a, b) =>
      a.confidence > b.confidence || a.lastVerifiedAt > b.lastVerifiedAt,
    );
    const compactedLibrary = pickBestByKey(library, (a, b) =>
      a.successCount > b.successCount || a.lastVerifiedAt > b.lastVerifiedAt,
    );
    const compactedStats = pickBestByKey(stats, (a, b) => a.lastRunAt > b.lastRunAt);
    const compactedTargetSelections = pickBestByKey(targetSelections, (a, b) => a.updatedAt > b.updatedAt);
    const compactedSchemaObservations = pickBestByKey(schemaObservations, (a, b) =>
      a.sightings > b.sightings || a.lastSeenAt > b.lastSeenAt,
    );
    const compactedSchemaJoins = pickBestByKey(schemaJoins, (a, b) =>
      a.sightings > b.sightings || a.lastSeenAt > b.lastSeenAt,
    );
    const compactedSchemaShapes = pickBestByKey(schemaShapes, (a, b) =>
      a.sightings > b.sightings || a.lastSeenAt > b.lastSeenAt,
    );
    const compactedGrpcSchemas = pickBestByKey(grpcSchemas, (a, b) => a.lastSeenAt > b.lastSeenAt);

    const after =
      compactedResolution.length +
      compactedLibrary.length +
      compactedStats.length +
      compactedTargetSelections.length +
      compactedSchemaObservations.length +
      compactedSchemaJoins.length +
      compactedSchemaShapes.length +
      compactedGrpcSchemas.length;
    this.saveAll({
      resolution: compactedResolution,
      library: compactedLibrary,
      stats: compactedStats,
      targetSelections: compactedTargetSelections,
      schemaObservations: compactedSchemaObservations,
      schemaJoins: compactedSchemaJoins,
      schemaShapes: compactedSchemaShapes,
      grpcSchemas: compactedGrpcSchemas,
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
    const grpcSchemas = this.loadGrpcSchemas();
    const cutoff = Date.now() - ttlHours * 3600 * 1000;
    const keepResolution = resolution.filter((r) => new Date(r.lastVerifiedAt).getTime() >= cutoff);
    const keepLibrary = library.filter((r) => new Date(r.lastVerifiedAt).getTime() >= cutoff);
    const keepStats = stats.filter((r) => new Date(r.lastRunAt).getTime() >= cutoff);
    const keepTargetSelections = targetSelections.filter((r) => new Date(r.updatedAt).getTime() >= cutoff);
    const keepSchemaObservations = schemaObservations.filter((r) => new Date(r.lastSeenAt).getTime() >= cutoff);
    const keepSchemaJoins = schemaJoins.filter((r) => new Date(r.lastSeenAt).getTime() >= cutoff);
    const keepSchemaShapes = schemaShapes.filter((r) => new Date(r.lastSeenAt).getTime() >= cutoff);
    const keepGrpcSchemas = grpcSchemas.filter((r) => new Date(r.lastSeenAt).getTime() >= cutoff);
    this.saveAll({
      resolution: keepResolution,
      library: keepLibrary,
      stats: keepStats,
      targetSelections: keepTargetSelections,
      schemaObservations: keepSchemaObservations,
      schemaJoins: keepSchemaJoins,
      schemaShapes: keepSchemaShapes,
      grpcSchemas: keepGrpcSchemas,
    });
    const before =
      resolution.length + library.length + stats.length + targetSelections.length + schemaObservations.length + schemaJoins.length + schemaShapes.length + grpcSchemas.length;
    const after =
      keepResolution.length +
      keepLibrary.length +
      keepStats.length +
      keepTargetSelections.length +
      keepSchemaObservations.length +
      keepSchemaJoins.length +
      keepSchemaShapes.length +
      keepGrpcSchemas.length;
    return { before, after };
  }

  clear(): void {
    this.saveAll({ resolution: [], library: [], stats: [], targetSelections: [], schemaObservations: [], schemaJoins: [], schemaShapes: [], grpcSchemas: [] });
  }
}
