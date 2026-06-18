export type Capability =
  | 'doctor'
  | 'resolveConnection'
  | 'resolveCredentials'
  | 'resolveDatabase'
  | 'executeRead'
  | 'executeMutate'
  | 'discoverSchema'
  | 'normalizeIds';

export type PluginKind = 'connector' | 'executor' | 'resolver';

export const DatasourceKind = {
  Mysql: 'mysql',
  Postgres: 'postgres',
  TeleportMysql: 'teleport-mysql',
  Redis: 'redis',
  Grpc: 'grpc',
} as const;
export type DatasourceKind = (typeof DatasourceKind)[keyof typeof DatasourceKind];

export const AccessMethod = {
  Native: 'native',
  QaPortforward: 'qa-portforward',
  Tsh: 'tsh',
} as const;
export type AccessMethod = (typeof AccessMethod)[keyof typeof AccessMethod];

export const DoctorStatus = {
  Ok: 'ok',
  Warn: 'warn',
  Fail: 'fail',
} as const;
export type DoctorStatus = (typeof DoctorStatus)[keyof typeof DoctorStatus];

export const EnsuredBy = {
  CachedLearning: 'cached-learning',
  RefreshedIntrospection: 'refreshed-introspection',
  Unresolved: 'unresolved',
  Empty: 'empty',
} as const;
export type EnsuredBy = (typeof EnsuredBy)[keyof typeof EnsuredBy];

export const TemplateStatus = {
  Active: 'active',
  Inactive: 'inactive',
} as const;
export type TemplateStatus = (typeof TemplateStatus)[keyof typeof TemplateStatus];

export const KbRelationSource = {
  Curated: 'curated',
  Derived: 'derived',
} as const;
export type KbRelationSource = (typeof KbRelationSource)[keyof typeof KbRelationSource];

export interface PluginManifest {
  name: string;
  version: string;
  kind: PluginKind;
  capabilities: Capability[];
  accessMethods?: AccessMethod[];
  configSchema?: Record<string, unknown>;
  priority?: number;
}

export interface DatasourcePolicy {
  allowRead: boolean;
  allowMutate: boolean;
  allowedCapabilities: Capability[];
}

export interface DatasourceProfile {
  name: string;
  kind: string;
  env?: string;
  namespace?: string;
  service?: string;
  tags?: string[];
  connection: {
    host?: string;
    port?: number;
    database?: string;
    target?: string;
    ssl?: boolean;
  };
  credentialRef: string;
  connectors?: string[];
  policy: DatasourcePolicy;
  resolverHints?: Record<string, string>;
  updatedAt: string;
  confidence: number;
}

export interface EnvironmentPolicy {
  deterministicRequired: boolean;
  allowDiscoveryByDefault: boolean;
  preferredAccessMethods: string[];
  targetPreference: string[];
  ledgerRedactionTier?: LedgerRedactionTier;
}

export interface RuntimeConfig {
  defaults?: {
    profile?: string;
    json?: boolean;
    noColor?: boolean;
    noAnimations?: boolean;
    learning?: {
      enabled?: boolean;
      sampleRowsMax?: number;
      sampleCellMax?: number;
      ttlHours?: number;
    };
    ledger?: {
      redactionTier?: LedgerRedactionTier;
    };
    cardRoots?: string[];
  };
  cardRoots?: string[];
  environmentPolicies?: Record<string, Partial<EnvironmentPolicy>>;
  serviceAliases?: Record<string, string>;
}

export interface QueryTemplate {
  id: string;
  datasourceKind?: string;
  datasourceName?: string;
  intent: string;
  aliases?: string[];
  nativeQueryTemplate: string;
  params: string[];
  resultShape: 'table' | 'json' | 'summary';
  tags: string[];
  status: TemplateStatus;
  verifiedAt?: string;
}

export interface QueryRequest {
  datasource: DatasourceProfile;
  query: string;
  capability: 'executeRead' | 'executeMutate';
  timeoutMs?: number;
  pluginParams?: Record<string, unknown>;
}

export interface QueryPhaseTimings {
  resolveMs?: number;
  connectMs?: number;
  executeMs?: number;
  totalMs?: number;
}

export interface QueryResult {
  runId: string;
  datasource: string;
  plugin: string;
  capability: Capability;
  query: { native: string };
  result: {
    columns: string[];
    rows: Array<Record<string, unknown>>;
  };
  timings: {
    startedAt: string;
    endedAt: string;
    durationMs: number;
    phases?: QueryPhaseTimings;
  };
  warnings: string[];
  classification: 'success' | 'error';
  meta?: {
    schemaContext?: SchemaContext;
    queryMemory?: QueryMemory;
  };
  resolved?: {
    source?: string;
    env?: string;
    namespace?: string;
    service?: string;
    accessMethod?: string;
    target?: string;
    database?: string;
    engine?: string;
  };
}

export type SchemaProvenance = 'observed-query' | 'refreshed-metadata' | 'manual';

export interface SchemaIndex {
  name: string;
  columns: string[];
  unique?: boolean;
  type?: string;
}

export interface SchemaPartition {
  kind: string;
  expr?: string;
  key?: string;
  keys?: string[];
}

export interface TableContext {
  database: string;
  columns: string[];
  primaryKey?: string[];
  indexes: SchemaIndex[];
  partition?: SchemaPartition;
  lastSeenAt?: string;
}

export interface RpcFieldShape {
  name: string;
  type: string;
  repeated?: boolean;
  optional?: boolean;
  oneof?: string;
}

export interface RpcMessageShape {
  name: string;
  fields: RpcFieldShape[];
}

export interface RpcEnumShape {
  name: string;
  values: Record<string, number>;
}

export interface RpcMethodShape {
  name: string;
  requestType: string;
  responseType: string;
  requestStream?: boolean;
  responseStream?: boolean;
}

export interface RpcServiceShape {
  name: string;
  methods: RpcMethodShape[];
}

export interface RelationEndpoint {
  service: string;
  table: string;
  column: string;
}

export interface KbRelation {
  id: string;
  from: RelationEndpoint;
  to: RelationEndpoint;
  relationship?: string;
  notes?: string;
  confidence?: number;
  source?: KbRelationSource;
}

export interface SchemaRelationEdge {
  from: string;
  to: string;
  relationship?: string;
  crossService: boolean;
  notes?: string;
  stale?: boolean;
  staleReason?: string;
}

export type RelationEndpointStatus = 'ok' | 'missing_table' | 'missing_column' | 'unknown_service';

export interface RelationValidation {
  id: string;
  from: string;
  to: string;
  fromStatus: RelationEndpointStatus;
  toStatus: RelationEndpointStatus;
  stale: boolean;
}

export interface SchemaContext {
  tables: Record<string, TableContext>;
  services?: Record<string, RpcServiceShape>;
  messages?: Record<string, RpcMessageShape>;
  enums?: Record<string, RpcEnumShape>;
  relations?: SchemaRelationEdge[];
}

export type LedgerRedactionTier = 'raw' | 'redact' | 'strict';

export interface QueryMemoryPastRun {
  runId: string;
  ts: string;
  datasource?: string;
  intent?: string;
  reason?: string;
  fingerprint?: string;
  outcomeCode: string;
  errorClass?: string;
  lesson?: string;
  tables: string[];
  durationMs?: number;
  rowCount?: number;
}

export interface QueryMemoryMatchedCard {
  id: string;
  purpose?: string;
  lastUsedAt?: string;
  lastOutcome?: string;
}

export interface QueryMemory {
  matchedCards?: QueryMemoryMatchedCard[];
  similarPastRuns?: QueryMemoryPastRun[];
  warnings?: string[];
  hints?: string[];
}

export type DoctorCheckCode =
  | 'connector_plugin_missing'
  | 'connector_mode_unsupported'
  | 'connector_status_command_missing'
  | 'connector_connect_command_missing'
  | 'connector_disconnect_command_missing'
  | 'connector_login_command_missing'
  | 'connector_status_blocked'
  | 'connector_connect_blocked'
  | 'connector_disconnect_blocked'
  | 'connector_check_failed'
  | 'connector_timeout'
  | 'executor_configuration_missing'
  | 'executor_connectivity'
  | 'executor_access_denied'
  | 'executor_auth_expired'
  | 'executor_unknown_target'
  | 'executor_query_timeout';

export interface DoctorCheck {
  check: string;
  status: DoctorStatus;
  detail: string;
  code?: DoctorCheckCode;
}

export interface RemediationAction {
  command: string;
  priority: number;
  reasons: string[];
  checks: string[];
  codes: DoctorCheckCode[];
}

export type DoctorNextAction = RemediationAction;

export interface TapRootPlugin {
  manifest: PluginManifest;
  doctor?: (input: { datasource: DatasourceProfile; credentials: Record<string, string> }) => Promise<DoctorCheck[]>;
  connect?: (input: { datasource: DatasourceProfile; credentials: Record<string, string> }) => Promise<DoctorCheck[]>;
  disconnect?: (input: { datasource: DatasourceProfile; credentials: Record<string, string> }) => Promise<DoctorCheck[]>;
  resolve?: (input: { datasource: Partial<DatasourceProfile>; env?: string; service?: string }) => Promise<Partial<DatasourceProfile>>;
  execute?: (request: QueryRequest, creds: Record<string, string>) => Promise<QueryResult>;
}

export interface CliOutputEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  meta?: {
    requestId?: string;
    runId?: string;
    sessionId?: string;
    schemaContext?: SchemaContext;
    queryMemory?: QueryMemory;
    timings?: {
      durationMs: number;
    };
    phases?: QueryPhaseTimings;
  };
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}
