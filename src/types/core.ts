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
}

export interface RuntimeConfig {
  kbDir?: string;
  defaults?: {
    query?: {
      timeoutMs?: number;
      timeZone?: string;
    };
  };
  environmentPolicies?: Record<string, Partial<EnvironmentPolicy>>;
  serviceAliases?: Record<string, string>;
}

export interface PluginParams {
  protoRoot?: string;
  protoMessage?: string;
  requestJson?: string;
  skipProtoValidate?: boolean;
  allowFlush?: boolean;
  params?: Record<string, string>;
}

export interface QueryRequest {
  datasource: DatasourceProfile;
  query: string;
  capability: 'executeRead' | 'executeMutate';
  timeoutMs?: number;
  sessionTimeZone: string;
  pluginParams?: PluginParams;
}

export interface QueryPhaseTimings {
  resolveMs?: number;
  connectMs?: number;
  executeMs?: number;
  totalMs?: number;
}

export interface QueryResult {
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

export interface SchemaCatalogSummary {
  tables: number;
  fetchedAt: string;
}

export interface SchemaContext {
  tables: Record<string, TableContext>;
  catalog?: SchemaCatalogSummary;
  services?: Record<string, RpcServiceShape>;
  messages?: Record<string, RpcMessageShape>;
  enums?: Record<string, RpcEnumShape>;
}

export type DoctorCheckCode =
  | 'connector_plugin_missing'
  | 'connector_mode_unsupported'
  | 'connector_status_command_missing'
  | 'connector_connect_command_missing'
  | 'connector_login_command_missing'
  | 'connector_status_blocked'
  | 'connector_connect_blocked'
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


export interface TapRootPlugin {
  manifest: PluginManifest;
  doctor?: (input: { datasource: DatasourceProfile; credentials: Record<string, string> }) => Promise<DoctorCheck[]>;
  connect?: (input: { datasource: DatasourceProfile; credentials: Record<string, string> }) => Promise<DoctorCheck[]>;
  execute?: (request: QueryRequest, creds: Record<string, string>) => Promise<QueryResult>;
}

export interface CliOutputEnvelope<T = unknown> {
  ok: boolean;
  data?: T;
  meta?: {
    requestId?: string;
    sessionId?: string;
    schemaContext?: SchemaContext;
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
