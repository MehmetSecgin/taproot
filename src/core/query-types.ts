import type { DatasourceProfile } from '../types/datasource.js';
import type { QueryResult } from '../types/plugin.js';
import type { SchemaContext } from '../types/schema-context.js';
import type { AppContext } from './app.js';
import type { QuerySlot } from './schema-refresh.js';

export type QueryExecutionRequest = {
  datasource?: string;
  optsEnv?: string;
  env: string;
  namespace: string;
  service: string;
  query: string;
  params: string[];
  allowDiscovery: boolean;
  allowMutate: boolean;
  allowPartitionScan: boolean;
  explain: boolean;
  rowsObject: boolean;
  jsonExtract: string[];
  proto?: string;
  protoRoot?: string;
  allowFlush: boolean;
  allowKeys: boolean;
  requestJson?: string;
  skipProtoValidate: boolean;
  timeoutMs: number;
  maxRows?: number;
  tz?: string;
};

export type QueryReport = {
  log: (message: string) => unknown;
};

export type QueryDeps = {
  ctx: AppContext;
  report: QueryReport;
  signal: AbortSignal | undefined;
  openSession?: (datasource: DatasourceProfile) => string;
  acquireQuerySlot: QuerySlot | undefined;
  resolveDatasource: DatasourceResolver;
};

type ResolvedQueryDatasource = {
  datasource: DatasourceProfile;
  source: string;
  warnings: string[];
};

export type DatasourceResolver = (request: QueryExecutionRequest, deps: Pick<QueryDeps, 'ctx' | 'report'>) => Promise<ResolvedQueryDatasource>;

export type QueryOutcomeMeta = {
  sessionId?: string;
  requestId?: string;
  resolved?: QueryResult['resolved'];
  phases?: NonNullable<QueryResult['timings']['phases']>;
  timings?: { durationMs: number };
  schemaContext?: SchemaContext;
};

export type QuerySuccessData = {
  columns: string[];
  rows: unknown[];
  rowsForm?: 'array';
  datasource: string;
  plugin: string;
  classification: 'success' | 'error';
  truncated?: true;
  warnings?: string[];
};

export type QueryOutcome =
  | { ok: true; data: QuerySuccessData; meta: QueryOutcomeMeta }
  | { ok: false; code: string; message: string; details?: unknown; meta: QueryOutcomeMeta };
