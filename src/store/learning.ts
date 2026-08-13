import fs from 'node:fs';
import path from 'node:path';
import type { DatasourceProfile, RpcEnumShape, RpcMessageShape, RpcServiceShape } from '../types/core.js';
import { RUNS_LEDGER_DIR_NAME } from '../core/paths.js';
import { nowIso } from '../core/time.js';
import { extractQueryShape } from '../core/schema-learning.js';
import type { RefreshedSchemaJoin, RefreshedSchemaTable } from '../core/schema-refresh.js';
import type { SchemaProvenance } from '../types/core.js';
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
  compactGrpcSchemas,
  filterGrpcSchemas,
  loadGrpcSchemas as loadGrpcSchemasFile,
  pruneGrpcSchemas,
  saveGrpcSchemas as saveGrpcSchemasFile,
  upsertGrpcSchema,
} from './learning-grpc.js';
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
  compactCatalog,
  findCatalogEntry,
  loadSchemaCatalog as loadSchemaCatalogFile,
  pruneCatalog,
  saveSchemaCatalog as saveSchemaCatalogFile,
  upsertCatalogEntry,
} from './learning-catalog.js';
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
  LearningStatus,
  ResolutionEntry,
  SchemaCatalogEntry,
  SchemaJoinEntry,
  SchemaObservationEntry,
} from './learning-types.js';

export { SCHEMA_METADATA_VERSION, bareTableName, schemaObservationHasCurrentMetadata } from './learning-utils.js';
export type {
  GrpcServiceSchemaEntry,
  LearningStatus,
  ResolutionEntry,
  SchemaCatalogEntry,
  SchemaJoinEntry,
  SchemaObservationEntry,
  SchemaTableColumnStat,
} from './learning-types.js';

export class LearningStore {
  private readonly resolutionFile: string;
  private readonly schemaObservationFile: string;
  private readonly schemaJoinFile: string;
  private readonly schemaCatalogFile: string;
  private readonly grpcSchemaFile: string;
  private readonly runsLedgerDir: string;
  private schemaKeysMigrated = false;

  constructor(private readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.resolutionFile = path.join(dir, 'resolution-cache.json');
    this.schemaObservationFile = path.join(dir, 'schema-observations.json');
    this.schemaJoinFile = path.join(dir, 'schema-joins.json');
    this.schemaCatalogFile = path.join(dir, 'schema-catalog.json');
    this.grpcSchemaFile = path.join(dir, 'grpc-schemas.json');
    this.runsLedgerDir = path.join(dir, RUNS_LEDGER_DIR_NAME);
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

  private loadSchemaObservations(): SchemaObservationEntry[] {
    this.migrateSchemaKeysIfNeeded();
    return loadSchemaObservationsFile(this.schemaObservationFile);
  }

  private loadSchemaJoins(): SchemaJoinEntry[] {
    this.migrateSchemaKeysIfNeeded();
    return loadSchemaJoinsFile(this.schemaJoinFile);
  }

  private loadSchemaCatalog(): SchemaCatalogEntry[] {
    return loadSchemaCatalogFile(this.schemaCatalogFile);
  }

  private loadGrpcSchemas(): GrpcServiceSchemaEntry[] {
    return loadGrpcSchemasFile(this.grpcSchemaFile);
  }

  private saveAll(input: {
    resolution?: ResolutionEntry[];
    schemaObservations?: SchemaObservationEntry[];
    schemaJoins?: SchemaJoinEntry[];
    schemaCatalog?: SchemaCatalogEntry[];
    grpcSchemas?: GrpcServiceSchemaEntry[];
  }): void {
    if (input.resolution) saveResolutionFile(this.resolutionFile, input.resolution);
    if (input.schemaObservations) saveSchemaObservationsFile(this.schemaObservationFile, input.schemaObservations);
    if (input.schemaJoins) saveSchemaJoinsFile(this.schemaJoinFile, input.schemaJoins);
    if (input.schemaCatalog) saveSchemaCatalogFile(this.schemaCatalogFile, input.schemaCatalog);
    if (input.grpcSchemas) saveGrpcSchemasFile(this.grpcSchemaFile, input.grpcSchemas);
  }

  private observeSchema(input: { datasource: DatasourceProfile; sql: string; now: string }): void {
    const schema = extractQueryShape(input.sql, { dialect: input.datasource.kind });
    const observations = this.loadSchemaObservations();
    const joins = this.loadSchemaJoins();
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

    this.saveAll({
      schemaObservations: observations,
      schemaJoins: joins,
    });
  }

  schemaTables(service?: string): SchemaObservationEntry[] {
    return filterObservations(this.loadSchemaObservations(), service);
  }

  schemaJoins(service?: string): SchemaJoinEntry[] {
    return filterJoins(this.loadSchemaJoins(), service);
  }

  grpcSchemas(service?: string): GrpcServiceSchemaEntry[] {
    return filterGrpcSchemas(this.loadGrpcSchemas(), service);
  }

  schemaCatalog(datasourceName: string): SchemaCatalogEntry | undefined {
    return findCatalogEntry(this.loadSchemaCatalog(), datasourceName);
  }

  saveSchemaCatalog(input: { datasource: DatasourceProfile; tableCount: number }): SchemaCatalogEntry {
    const rows = this.loadSchemaCatalog();
    const entry = upsertCatalogEntry(rows, { ...input, now: nowIso() });
    this.saveAll({ schemaCatalog: rows });
    return entry;
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

    this.saveAll({
      schemaObservations: observations,
      schemaJoins: joins,
    });
  }

  status(): LearningStatus {
    const resolution = this.loadResolution();
    const schemaObservations = this.loadSchemaObservations();
    const schemaJoins = this.loadSchemaJoins();
    const schemaCatalog = this.loadSchemaCatalog();
    const grpcSchemas = this.loadGrpcSchemas();
    const latest = [
      ...resolution.map((row) => row.lastVerifiedAt),
      ...schemaObservations.map((row) => row.lastSeenAt),
      ...schemaJoins.map((row) => row.lastSeenAt),
      ...schemaCatalog.map((row) => row.fetchedAt),
      ...grpcSchemas.map((row) => row.lastSeenAt),
    ]
      .filter(Boolean)
      .sort()
      .at(-1);
    return {
      files: {
        resolution: resolution.length,
        schemaObservations: schemaObservations.length,
        schemaJoins: schemaJoins.length,
        schemaCatalog: schemaCatalog.length,
        grpcSchemas: grpcSchemas.length,
      },
      latest,
    };
  }

  resolveConnection(env: string, service: string, namespace?: string): ResolutionEntry | undefined {
    return resolveConnectionFromRows(this.loadResolution(), env, service, namespace);
  }

  saveSuccess(input: { datasource: DatasourceProfile; sql: string }): void {
    const resolution = this.loadResolution();
    const now = nowIso();
    upsertResolutionSuccess(resolution, { datasource: input.datasource, now });
    this.observeSchema({ datasource: input.datasource, sql: input.sql, now });
    this.saveAll({ resolution });
  }

  saveFailure(datasource?: DatasourceProfile): void {
    if (!datasource) return;
    const resolution = this.loadResolution();
    applyResolutionFailure(resolution, { datasource, now: nowIso() });
    this.saveAll({ resolution });
  }

  compact(): { before: number; after: number } {
    const resolution = this.loadResolution();
    const schemaObservations = this.loadSchemaObservations();
    const schemaJoins = this.loadSchemaJoins();
    const schemaCatalog = this.loadSchemaCatalog();
    const grpcSchemas = this.loadGrpcSchemas();
    const before =
      resolution.length + schemaObservations.length + schemaJoins.length + schemaCatalog.length + grpcSchemas.length;

    const compactedResolution = compactResolution(resolution);
    const compactedSchemaObservations = compactObservations(schemaObservations);
    const compactedSchemaJoins = compactJoins(schemaJoins);
    const compactedSchemaCatalog = compactCatalog(schemaCatalog);
    const compactedGrpcSchemas = compactGrpcSchemas(grpcSchemas);

    const after =
      compactedResolution.length +
      compactedSchemaObservations.length +
      compactedSchemaJoins.length +
      compactedSchemaCatalog.length +
      compactedGrpcSchemas.length;
    this.saveAll({
      resolution: compactedResolution,
      schemaObservations: compactedSchemaObservations,
      schemaJoins: compactedSchemaJoins,
      schemaCatalog: compactedSchemaCatalog,
      grpcSchemas: compactedGrpcSchemas,
    });
    return { before, after };
  }

  prune(ttlHours: number): { before: number; after: number } {
    const resolution = this.loadResolution();
    const schemaObservations = this.loadSchemaObservations();
    const schemaJoins = this.loadSchemaJoins();
    const schemaCatalog = this.loadSchemaCatalog();
    const grpcSchemas = this.loadGrpcSchemas();
    const cutoff = Date.now() - ttlHours * 3600 * 1000;
    const keepResolution = pruneResolution(resolution, cutoff);
    const keepSchemaObservations = pruneObservations(schemaObservations, cutoff);
    const keepSchemaJoins = pruneJoins(schemaJoins, cutoff);
    const keepSchemaCatalog = pruneCatalog(schemaCatalog, cutoff);
    const keepGrpcSchemas = pruneGrpcSchemas(grpcSchemas, cutoff);
    this.saveAll({
      resolution: keepResolution,
      schemaObservations: keepSchemaObservations,
      schemaJoins: keepSchemaJoins,
      schemaCatalog: keepSchemaCatalog,
      grpcSchemas: keepGrpcSchemas,
    });
    const before =
      resolution.length + schemaObservations.length + schemaJoins.length + schemaCatalog.length + grpcSchemas.length;
    const after =
      keepResolution.length +
      keepSchemaObservations.length +
      keepSchemaJoins.length +
      keepSchemaCatalog.length +
      keepGrpcSchemas.length;
    return { before, after };
  }

  clear(): void {
    this.saveAll({ resolution: [], schemaObservations: [], schemaJoins: [], schemaCatalog: [], grpcSchemas: [] });
    fs.rmSync(this.runsLedgerDir, { recursive: true, force: true });
    fs.mkdirSync(this.runsLedgerDir, { recursive: true });
  }
}
