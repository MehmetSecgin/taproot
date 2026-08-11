import type { DatasourceProfile, RpcEnumShape, RpcMessageShape, RpcServiceShape, SchemaIndex, SchemaPartition, SchemaProvenance } from '../types/core.js';

export interface ResolutionEntry {
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

export interface SchemaCatalogEntry {
  key: string;
  env: string;
  service: string;
  database: string;
  fetchedAt: string;
  tableCount: number;
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

export interface LearningStatus {
  files: {
    resolution: number;
    schemaObservations: number;
    schemaJoins: number;
    schemaCatalog: number;
    grpcSchemas: number;
  };
  latest?: string;
}

export interface GrpcServiceSchemaEntry {
  key: string;
  datasource: string;
  env: string;
  service: string;
  kind: string;
  protoRoot: string;
  services: RpcServiceShape[];
  messages: Record<string, RpcMessageShape>;
  enums: Record<string, RpcEnumShape>;
  firstSeenAt: string;
  lastSeenAt: string;
  sources: SchemaProvenance[];
}
