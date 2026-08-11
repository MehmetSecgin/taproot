import type { AppContext } from '../core/app.js';
import type { QueryOutcome } from '../core/execute-query.js';
import { printJsonPluck, renderSchemaContextFooter, renderTableSmart, rowToObject, trimQueryJsonEnvelope } from '../core/output.js';
import type { ProgressReporter } from '../core/progress.js';
import { renderQueryMemoryTty } from '../core/query-memory.js';
import { str } from '../core/strings.js';

export interface PresentOptions {
  full?: boolean;
  rowsObject?: boolean;
  pluck?: string;
  verbose?: boolean;
}

export function queryFailureError(outcome: Extract<QueryOutcome, { ok: false }>): Error {
  const prefixed = outcome.message.toLowerCase().startsWith(`${outcome.code.toLowerCase()}:`)
    ? outcome.message
    : `${outcome.code}: ${outcome.message}`;
  const error = new Error(prefixed) as Error & { details?: unknown; meta?: unknown };
  error.details = outcome.details;
  error.meta = outcome.meta;
  return error;
}

export function presentQueryOutcome(input: {
  outcome: QueryOutcome;
  ctx: AppContext;
  opts: PresentOptions;
  progress: ProgressReporter;
  requestId: string;
}): void {
  const { outcome, ctx, opts, progress, requestId } = input;
  if (!outcome.ok) {
    progress.fail(`query failed (${outcome.code})`);
    throw queryFailureError({ ...outcome, meta: { ...outcome.meta, requestId } });
  }

  const { data, meta } = outcome;
  if (ctx.jsonMode) {
    const envelope = trimQueryJsonEnvelope({ ok: true, data, meta: { ...meta, requestId } });
    printJsonPluck(envelope, opts.pluck ? String(opts.pluck) : undefined);
    return;
  }

  const phases = meta.phases;
  const phaseSummary =
    ctx.verbose && phases
      ? ` [resolve ${phases.resolveMs}ms · connect ${phases.connectMs}ms · execute ${phases.executeMs}ms]`
      : '';
  const durationMs = meta.timings?.durationMs;
  progress.succeed(`query complete (${data.rows.length} rows${durationMs === undefined ? '' : `, ${durationMs}ms`})${phaseSummary}`);
  if (data.warnings?.length) progress.warn(`warnings: ${data.warnings.join(' | ')}`);

  const resolved = meta.resolved;
  if (resolved) {
    console.log(
      `resolved via=${str(resolved.source)} env=${str(resolved.env)} service=${str(resolved.service)} engine=${str(resolved.engine)} target=${str(resolved.target)} database=${str(resolved.database)}`,
    );
  }
  const tableRows = opts.rowsObject
    ? (data.rows as Array<Record<string, unknown>>)
    : data.rows.map((row) => rowToObject(data.columns, row));
  console.log(renderTableSmart(tableRows, { full: Boolean(opts.full) }));
  const footer = renderSchemaContextFooter(meta.schemaContext);
  if (footer) console.log(footer);
  const renderedMemory = renderQueryMemoryTty(meta.queryMemory);
  if (renderedMemory) console.log(renderedMemory);
}
