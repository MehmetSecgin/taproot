import type { Capability, DatasourceProfile } from './datasource.js';
import type { SchemaContext } from './schema-context.js';

export const DoctorStatus = {
  Ok: 'ok',
  Warn: 'warn',
  Fail: 'fail',
} as const;

export type DoctorStatus = (typeof DoctorStatus)[keyof typeof DoctorStatus];

type PluginManifest = {
  name: string;
  capabilities: Capability[];
};

export type PluginParams = {
  protoRoot?: string;
  protoMessage?: string;
  requestJson?: string;
  skipProtoValidate?: boolean;
  allowFlush?: boolean;
  allowKeys?: boolean;
  params?: Record<string, string>;
};

export type QueryRequest = {
  datasource: DatasourceProfile;
  query: string;
  capability: 'executeRead' | 'executeMutate';
  timeoutMs?: number;
  maxRows?: number;
  sessionTimeZone: string;
  pluginParams?: PluginParams;
  signal: AbortSignal | undefined;
};

export type QueryPhaseTimings = {
  resolveMs?: number;
  connectMs?: number;
  executeMs?: number;
  totalMs?: number;
};

export type QueryResult = {
  datasource: string;
  plugin: string;
  capability: Capability;
  query: { native: string };
  result: {
    columns: string[];
    rows: unknown[][];
    truncated?: boolean;
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
};

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
  | 'executor_missing_tool'
  | 'executor_access_denied'
  | 'executor_auth_expired'
  | 'executor_unknown_target'
  | 'executor_query_timeout';

export type DoctorCheck = {
  check: string;
  status: DoctorStatus;
  detail: string;
  code?: DoctorCheckCode;
};

export type TapRootPlugin = {
  manifest: PluginManifest;
  doctor?: (input: { datasource: DatasourceProfile; credentials: Record<string, string> }) => Promise<DoctorCheck[]>;
  connect?: (input: { datasource: DatasourceProfile; credentials: Record<string, string> }) => Promise<DoctorCheck[]>;
  execute?: (request: QueryRequest, creds: Record<string, string>) => Promise<QueryResult>;
  closeSession?: (sessionId: string) => Promise<void>;
  close?: () => Promise<void>;
};

export type PluginRegistry = Map<string, TapRootPlugin>;
