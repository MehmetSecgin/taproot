import fs from 'node:fs';
import path from 'node:path';
import type { DatasourceProfile, QueryResult, RpcEnumShape, RpcMessageShape, RpcServiceShape } from '../types/core.js';
import { nowIso } from '../core/time.js';
import { extractQueryShape } from '../core/schema-learning.js';
import type { RefreshedSchemaJoin, RefreshedSchemaTable } from '../core/schema-refresh.js';
import type { SchemaProvenance } from '../types/core.js';
import { str } from '../core/strings.js';
import { normalizeIntent, normalizeSqlTemplate, stableId } from './learning-utils.js';
import {
  applyResolutionFailure,
  compactResolution,
  loadResolution as loadResolutionFile,
  pruneResolution,
  resolveConnectionFromRows,
  saveResolution as saveResolutionFile,
  upsertResolutionSuccess,
} from './learning-resolution.js';
import {
  compactLibrary,
  loadLibrary as loadLibraryFile,
  pruneLibrary,
  recordLibrarySuccess,
  resolveTemplateFromRows,
  saveLibrary as saveLibraryFile,
  upsertQueryTemplate,
} from './learning-library.js';
import {
  compactStats,
  loadStats as loadStatsFile,
  pruneStats,
  recordStatFailure,
  recordStatSuccess,
  saveStats as saveStatsFile,
} from './learning-stats.js';
import {
  compactTargetSelections,
  loadTargetSelections as loadTargetSelectionsFile,
  pruneTargetSelections,
  resolveTargetSelectionFromRows,
  saveTargetSelections as saveTargetSelectionsFile,
  upsertTargetSelection,
} from './learning-target-selections.js';
import {
  compactGrpcSchemas,
  filterGrpcSchemas,
  loadGrpcSchemas as loadGrpcSchemasFile,
  pruneGrpcSchemas,
  saveGrpcSchemas as saveGrpcSchemasFile,
  upsertGrpcSchema,
} from './learning-grpc.js';
import {
  compactShapes,
  filterShapes,
  loadSchemaShapes as loadSchemaShapesFile,
  pruneShapes,
  saveSchemaShapes as saveSchemaShapesFile,
  upsertShapeFromObservedQuery,
  upsertShapeFromRefresh,
} from './learning-shapes.js';
import {
  compactJoins,
  filterJoins,
  loadSchemaJoins as loadSchemaJoinsFile,
  migrateSchemaJoinsFile,
  pruneJoins,
  saveSchemaJoins as saveSchemaJoinsFile,
  upsertJoinsFromObservedQuery,
  upsertJoinsFromRefresh,
} from './learning-joins.js';
import {
  compactObservations,
  filterObservations,
  loadSchemaObservations as loadSchemaObservationsFile,
  migrateSchemaObservationsFile,
  pruneObservations,
  saveSchemaObservations as saveSchemaObservationsFile,
  upsertObservationsFromObservedQuery,
  upsertObservationsFromRefresh,
} from './learning-observations.js';
import type {
  GrpcServiceSchemaEntry,
  QueryLibraryEntry,
  QueryStatEntry,
  ResolutionEntry,
  SchemaJoinEntry,
  SchemaObservationEntry,
  SchemaQueryShapeEntry,
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

  private migrateSchemaKeysIfNeeded(): void {
    if (this.schemaKeysMigrated) return;
    this.schemaKeysMigrated = true;
    migrateSchemaObservationsFile(this.schemaObservationFile);
    migrateSchemaJoinsFile(this.schemaJoinFile);
  }

  private loadResolution(): ResolutionEntry[] {
    return loadResolutionFile(this.resolutionFile);
  }

  private loadLibrary(): QueryLibraryEntry[] {
    return loadLibraryFile(this.libraryFile);
  }

  private loadStats(): QueryStatEntry[] {
    return loadStatsFile(this.statsFile);
  }

  private loadTargetSelections(): TargetSelectionEntry[] {
    return loadTargetSelectionsFile(this.targetSelectionFile);
  }

  private loadSchemaObservations(): SchemaObservationEntry[] {
    this.migrateSchemaKeysIfNeeded();
    return loadSchemaObservationsFile(this.schemaObservationFile);
  }

  private loadSchemaJoins(): SchemaJoinEntry[] {
    this.migrateSchemaKeysIfNeeded();
    return loadSchemaJoinsFile(this.schemaJoinFile);
  }

  private loadSchemaShapes(): SchemaQueryShapeEntry[] {
    return loadSchemaShapesFile(this.schemaShapeFile);
  }

  private loadGrpcSchemas(): GrpcServiceSchemaEntry[] {
    return loadGrpcSchemasFile(this.grpcSchemaFile);
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
    if (input.resolution) saveResolutionFile(this.resolutionFile, input.resolution);
    if (input.library) saveLibraryFile(this.libraryFile, input.library);
    if (input.stats) saveStatsFile(this.statsFile, input.stats);
    if (input.targetSelections) saveTargetSelectionsFile(this.targetSelectionFile, input.targetSelections);
    if (input.schemaObservations) saveSchemaObservationsFile(this.schemaObservationFile, input.schemaObservations);
    if (input.schemaJoins) saveSchemaJoinsFile(this.schemaJoinFile, input.schemaJoins);
    if (input.schemaShapes) saveSchemaShapesFile(this.schemaShapeFile, input.schemaShapes);
    if (input.grpcSchemas) saveGrpcSchemasFile(this.grpcSchemaFile, input.grpcSchemas);
  }

  private observeSchema(input: { datasource: DatasourceProfile; sql: string; now: string }): void {
    const schema = extractQueryShape(input.sql, { dialect: input.datasource.kind });
    const observations = this.loadSchemaObservations();
    const joins = this.loadSchemaJoins();
    const shapes = this.loadSchemaShapes();
    const datasource = input.datasource;

    upsertObservationsFromObservedQuery(observations, {
      datasource,
      tables: schema.tables,
      columns: schema.columns,
      now: input.now,
    });

    upsertJoinsFromObservedQuery(joins, {
      datasource,
      joins: schema.joins,
      schemaConfidence: schema.confidence,
      now: input.now,
    });

    upsertShapeFromObservedQuery(shapes, {
      datasource,
      operation: schema.operation,
      normalizedSql: schema.normalizedSql,
      tables: schema.tables,
      joins: schema.joins,
      confidence: schema.confidence,
      now: input.now,
    });

    this.saveAll({
      schemaObservations: observations,
      schemaJoins: joins,
      schemaShapes: shapes,
    });
  }

  schemaTables(service?: string): SchemaObservationEntry[] {
    return filterObservations(this.loadSchemaObservations(), service);
  }

  schemaJoins(service?: string): SchemaJoinEntry[] {
    return filterJoins(this.loadSchemaJoins(), service);
  }

  schemaQueryShapes(datasourceName?: string): SchemaQueryShapeEntry[] {
    return filterShapes(this.loadSchemaShapes(), datasourceName);
  }

  grpcSchemas(service?: string): GrpcServiceSchemaEntry[] {
    return filterGrpcSchemas(this.loadGrpcSchemas(), service);
  }

  saveGrpcSchema(input: {
    datasource: DatasourceProfile;
    protoRoot: string;
    source?: SchemaProvenance;
    services: RpcServiceShape[];
    messages: Record<string, RpcMessageShape>;
    enums: Record<string, RpcEnumShape>;
  }): GrpcServiceSchemaEntry {
    const rows = this.loadGrpcSchemas();
    const entry = upsertGrpcSchema(rows, { ...input, now: nowIso() });
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

    upsertObservationsFromRefresh(observations, {
      datasource,
      source: input.source,
      tables: input.tables,
      now,
    });

    upsertJoinsFromRefresh(joins, {
      datasource,
      source: input.source,
      joins: input.joins,
      now,
    });

    upsertShapeFromRefresh(shapes, {
      datasource,
      source: input.source,
      tables: input.tables,
      joins: input.joins,
      now,
    });

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
    return resolveConnectionFromRows(this.loadResolution(), env, service, namespace);
  }

  resolveQueryTemplate(service: string, intent: string): QueryLibraryEntry | undefined {
    return resolveTemplateFromRows(this.loadLibrary(), service, intent);
  }

  resolveTargetSelection(env: string, service: string, intent: string, namespace?: string): TargetSelectionEntry | undefined {
    return resolveTargetSelectionFromRows(this.loadTargetSelections(), env, service, intent, namespace);
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
    const entry = upsertTargetSelection(rows, { ...input, now: nowIso() });
    this.saveAll({ targetSelections: rows });
    return entry;
  }

  saveQueryTemplate(input: {
    service: string;
    intent: string;
    sqlTemplate: string;
    source?: 'learned' | 'kb' | 'manual';
  }): QueryLibraryEntry {
    const library = this.loadLibrary();
    const entry = upsertQueryTemplate(library, { ...input, now: nowIso() });
    this.saveAll({ library });
    return entry;
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
    upsertResolutionSuccess(resolution, { datasource: input.datasource, now });
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

    const libraryEntry = recordLibrarySuccess(library, {
      service,
      intent: input.queryIntent,
      sql: input.sql,
      now,
    });
    if (libraryEntry) {
      recordStatSuccess(stats, {
        datasourceName: input.datasource.name,
        templateId: libraryEntry.id,
        durationMs: input.result.timings.durationMs,
        now,
      });
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
    const now = nowIso();
    const service = str(input.datasource.service).trim();

    applyResolutionFailure(resolution, { datasource: input.datasource, now });

    const sqlTemplate = input.sql ? normalizeSqlTemplate(input.sql) : '';
    const intentKey = normalizeIntent(input.queryIntent) || 'auto';
    const key = service && sqlTemplate ? `${service}|${intentKey}|${sqlTemplate}` : '';
    const templateId = key ? stableId(key) : '';
    if (templateId) {
      recordStatFailure(stats, {
        datasourceName: input.datasource.name,
        templateId,
        errorClass: input.errorClass,
        durationMs: input.durationMs,
        now,
      });
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

    const compactedResolution = compactResolution(resolution);
    const compactedLibrary = compactLibrary(library);
    const compactedStats = compactStats(stats);
    const compactedTargetSelections = compactTargetSelections(targetSelections);
    const compactedSchemaObservations = compactObservations(schemaObservations);
    const compactedSchemaJoins = compactJoins(schemaJoins);
    const compactedSchemaShapes = compactShapes(schemaShapes);
    const compactedGrpcSchemas = compactGrpcSchemas(grpcSchemas);

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
    const keepResolution = pruneResolution(resolution, cutoff);
    const keepLibrary = pruneLibrary(library, cutoff);
    const keepStats = pruneStats(stats, cutoff);
    const keepTargetSelections = pruneTargetSelections(targetSelections, cutoff);
    const keepSchemaObservations = pruneObservations(schemaObservations, cutoff);
    const keepSchemaJoins = pruneJoins(schemaJoins, cutoff);
    const keepSchemaShapes = pruneShapes(schemaShapes, cutoff);
    const keepGrpcSchemas = pruneGrpcSchemas(grpcSchemas, cutoff);
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
