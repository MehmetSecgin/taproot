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

export interface PluginManifest {
  name: string;
  version: string;
  kind: PluginKind;
  capabilities: Capability[];
  accessMethods?: string[];
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
  status: 'active' | 'deprecated';
  verifiedAt?: string;
}

export interface QueryRequest {
  datasource: DatasourceProfile;
  query: string;
  capability: 'executeRead' | 'executeMutate';
  timeoutMs?: number;
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
  };
  warnings: string[];
  classification: 'success' | 'error';
}

export interface DoctorCheck {
  check: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export interface TelequeryPlugin {
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
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}
