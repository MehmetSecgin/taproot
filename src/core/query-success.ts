import type { QueryOutcome, QuerySuccessData } from './query-types.js';
import { applyJsonExtract } from './json-extract.js';
import type { PluginExecution, QueryRun } from './query-plugin-run.js';
import { rowObject } from './rows.js';
import { emptyToUndefined, firstNonEmpty, textUnlessFalsy } from './text-presence.js';
import type { QueryResult } from '../types/plugin.js';
import type { SchemaContext } from '../types/schema-context.js';

type SuccessTimings = {
  connectMs: number;
  execution: PluginExecution;
};

function mergeSchemaContext(base: SchemaContext, pluginSchema: SchemaContext | undefined): SchemaContext {
  if (!pluginSchema) {
    return base;
  }
  return { ...base, ...pluginSchema, tables: { ...base.tables, ...pluginSchema.tables } };
}

function withinRowCap(result: QueryResult['result'], maxRows: number | undefined): { rows: unknown[][]; truncated: boolean } {
  if (maxRows === undefined) {
    return { rows: result.rows, truncated: Boolean(result.truncated) };
  }
  return { rows: result.rows.slice(0, maxRows), truncated: Boolean(result.truncated) || result.rows.length > maxRows };
}

function buildSuccessData(run: QueryRun, result: QueryResult): QuerySuccessData {
  const { request, prepared } = run;
  const capped = withinRowCap(result.result, request.maxRows);
  const { columns, rows } = applyJsonExtract(result.result.columns, capped.rows, prepared.jsonExtractSpecs);
  return {
    columns,
    rows: request.rowsObject ? rows.map((row) => rowObject(columns, row)) : rows,
    datasource: prepared.datasource.name,
    plugin: result.plugin,
    classification: result.classification,
    ...(request.rowsObject ? {} : { rowsForm: 'array' as const }),
    ...(capped.truncated ? { truncated: true as const } : {}),
    ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
  };
}

function describeResolution(run: QueryRun): NonNullable<QueryResult['resolved']> {
  const { request, deps, prepared } = run;
  const { datasource } = prepared;
  const kbEntry = deps.ctx.kbStore.resolveConnection(request.service, request.env, emptyToUndefined(request.namespace));
  return {
    source: prepared.resolutionSource,
    env: request.env,
    namespace: firstNonEmpty(datasource.namespace, request.namespace),
    service: request.service,
    accessMethod: textUnlessFalsy(kbEntry?.access_method),
    target: textUnlessFalsy(datasource.connection.target),
    database: textUnlessFalsy(datasource.connection.database),
    engine: datasource.kind,
  };
}

export function buildSuccessOutcome(run: QueryRun, timings: SuccessTimings, warnings: string[]): QueryOutcome {
  const { result } = timings.execution;
  if (warnings.length > 0) {
    result.warnings = [...(result.warnings ?? []), ...warnings];
  }
  const phases = {
    resolveMs: run.prepared.resolveMs,
    connectMs: timings.connectMs,
    executeMs: timings.execution.executeMs,
    totalMs: Date.now() - run.startedAt,
  };
  const data = buildSuccessData(run, result);
  return {
    ok: true,
    data,
    meta: {
      sessionId: run.prepared.sessionId,
      schemaContext: mergeSchemaContext(run.schemaContext, result.meta?.schemaContext),
      resolved: describeResolution(run),
      phases,
      timings: { durationMs: result.timings.durationMs },
    },
  };
}
