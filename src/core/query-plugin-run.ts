import { connectorFailureSummary, runDatasourceConnectors } from './connector-runner.js';
import type { QueryDeps, QueryExecutionRequest } from './query-types.js';
import type { PreparedQuery } from './query-preparation.js';
import { preflightBudgetMs, withQueryTimeout } from './query-timeout.js';
import { isNonEmpty } from './text-presence.js';
import { DatasourceKind } from '../types/datasource.js';
import type { DoctorCheck, PluginParams, QueryRequest, QueryResult, TapRootPlugin } from '../types/plugin.js';
import type { SchemaContext } from '../types/schema-context.js';
import { withSessionId } from './session-credentials.js';

export type QueryRun = {
  request: QueryExecutionRequest;
  deps: QueryDeps;
  prepared: PreparedQuery;
  startedAt: number;
  schemaContext: SchemaContext;
  sessionTimeZone: string;
  pluginName: string;
  execute: NonNullable<TapRootPlugin['execute']>;
  capability: QueryRequest['capability'];
  credentials: Record<string, string>;
};

export type PluginExecution = {
  result: QueryResult;
  executeMs: number;
};

const MIN_REMAINING_MS = 1;

function buildPluginParams(request: QueryExecutionRequest, params: Record<string, string>, kind: string): PluginParams | undefined {
  const pluginParams: PluginParams = {
    ...(isNonEmpty(request.proto) ? { protoMessage: request.proto } : {}),
    ...(isNonEmpty(request.protoRoot) ? { protoRoot: request.protoRoot } : {}),
    ...(request.allowFlush ? { allowFlush: true } : {}),
    ...(request.allowKeys ? { allowKeys: true } : {}),
    ...(isNonEmpty(request.requestJson) ? { requestJson: request.requestJson } : {}),
    ...(request.skipProtoValidate ? { skipProtoValidate: true } : {}),
    ...(kind === DatasourceKind.Grpc && Object.keys(params).length > 0 ? { params } : {}),
  };
  return Object.keys(pluginParams).length > 0 ? pluginParams : undefined;
}

function logConnectorChecks(run: QueryRun, checks: DoctorCheck[]): void {
  for (const check of checks) {
    run.deps.report.log(`connector ${check.check}: ${check.status}`);
  }
}

function failIfConnectorFailed(checks: DoctorCheck[]): void {
  const failureSummary = connectorFailureSummary(checks);
  if (failureSummary !== undefined) {
    throw new Error(`connector preflight failed: ${failureSummary}`);
  }
}

export async function preflightConnectors(run: QueryRun): Promise<number> {
  const { request, deps, prepared } = run;
  deps.report.log('checking connectors');
  const connectStart = Date.now();
  const connectorChecks = await withQueryTimeout({
    timeoutMs: preflightBudgetMs(request.timeoutMs),
    signal: deps.signal,
    run: async () =>
      runDatasourceConnectors({
        datasource: prepared.datasource,
        credentialStore: deps.ctx.credentialStore,
        pluginRegistry: deps.ctx.pluginRegistry,
        mode: 'connect',
      }),
  });
  const connectMs = Date.now() - connectStart;
  logConnectorChecks(run, connectorChecks);
  failIfConnectorFailed(connectorChecks);
  return connectMs;
}

function pluginCredentials(run: QueryRun): Record<string, string> {
  const { sessionId } = run.prepared;
  return withSessionId(run.credentials, sessionId);
}

export async function executePlugin(run: QueryRun): Promise<PluginExecution> {
  const { request, deps, prepared, execute } = run;
  deps.report.log(`executing query via ${run.pluginName}`);
  const executeStart = Date.now();
  const remainingMs = (): number => Math.max(MIN_REMAINING_MS, executeStart + request.timeoutMs - Date.now());
  const executedQuery = request.explain ? `EXPLAIN ${prepared.query}` : prepared.query;
  const pluginParams = buildPluginParams(request, prepared.params, prepared.datasource.kind);
  const result = await withQueryTimeout({
    timeoutMs: remainingMs(),
    signal: deps.signal,
    run: async (signal) =>
      execute(
        {
          datasource: prepared.datasource,
          query: executedQuery,
          capability: run.capability,
          timeoutMs: remainingMs(),
          maxRows: request.maxRows,
          sessionTimeZone: run.sessionTimeZone,
          pluginParams,
          signal,
        },
        pluginCredentials(run),
      ),
  });
  return { result, executeMs: Date.now() - executeStart };
}
