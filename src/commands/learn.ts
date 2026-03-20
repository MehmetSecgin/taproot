import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../core/app.js';
import { normalizeService } from '../core/app.js';
import { bootstrapDatasource } from '../core/bootstrap.js';
import { printJson, renderRecord, renderTable } from '../core/output.js';
import { refreshSchemaForDatasource, supportsSchemaRefresh } from '../core/schema-refresh.js';
import type { DatasourceProfile } from '../types/core.js';

async function resolveDatasource(ctx: AppContext, opts: { datasource?: string; env?: string; service?: string }): Promise<DatasourceProfile | undefined> {
  if (opts.datasource) return ctx.datasourceStore.get(String(opts.datasource));
  const env = String(opts.env || '').trim();
  const service = normalizeService(String(opts.service || ''), ctx.runtimeConfigStore.serviceAliases());
  if (!env || !service) return undefined;
  const ds = ctx.datasourceStore.resolveByEnvService(env, service);
  if (ds) return ds;
  const bootstrapped = await bootstrapDatasource(ctx, env, service, `${env}-${service}`);
  return bootstrapped?.profile;
}

function emptyState(input: {
  datasource?: DatasourceProfile;
  rows: unknown[];
  kind: 'tables' | 'joins' | 'shapes';
  unresolved?: boolean;
}): { emptyReason: string | null; suggestedNextCommand: string | null } {
  if (input.rows.length) return { emptyReason: null, suggestedNextCommand: null };
  if (input.unresolved) return { emptyReason: 'datasource_unresolved', suggestedNextCommand: null };
  if (!input.datasource) return { emptyReason: 'no_learning_yet', suggestedNextCommand: null };
  if (!supportsSchemaRefresh(input.datasource)) {
    return { emptyReason: 'learning_unsupported', suggestedNextCommand: null };
  }
  return {
    emptyReason: 'schema_refresh_required',
    suggestedNextCommand: `taproot --json learn refresh-schema --datasource ${input.datasource.name}`,
  };
}

function printEmptyState(kind: 'tables' | 'joins' | 'shapes', state: { emptyReason: string | null; suggestedNextCommand: string | null }): void {
  if (!state.emptyReason) return;
  console.log(`No learned schema ${kind} found (${state.emptyReason}).`);
  if (state.suggestedNextCommand) console.log(`next: ${state.suggestedNextCommand}`);
}

export function registerLearn(program: Command, getCtx: () => AppContext): void {
  const l = program.command('learn').description('Learning cache operations');

  l.command('status').action(() => {
    const ctx = getCtx();
    const status = ctx.learningStore.status();
    if (ctx.jsonMode) printJson(status);
    else {
      console.log(renderRecord({ latest: status.latest || '' }));
      console.log(renderTable([
        { metric: 'resolution entries', value: status.files.resolution },
        { metric: 'query library entries', value: status.files.queryLibrary },
        { metric: 'query stats entries', value: status.files.queryStats },
        { metric: 'schema observation entries', value: status.files.schemaObservations },
        { metric: 'schema join entries', value: status.files.schemaJoins },
        { metric: 'schema shape entries', value: status.files.schemaShapes },
      ]));
    }
  });

  l.command('compact').action(() => {
    const ctx = getCtx();
    const out = ctx.learningStore.compact();
    if (ctx.jsonMode) printJson(out);
    else console.log(`compacted: before=${out.before} after=${out.after}`);
  });

  l.command('replay').requiredOption('--run-id <id>').action((opts) => {
    const ctx = getCtx();
    const runId = String(opts.runId || '').trim();
    const runDir = path.join(ctx.paths.runsDir, runId);
    const summaryFile = path.join(runDir, 'summary.json');
    if (!runId || !fs.existsSync(summaryFile)) {
      throw new Error(`Run artifact not found: ${runId}`);
    }
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8')) as Record<string, any>;
    const eventsFile = path.join(runDir, 'events.log');
    const events = fs.existsSync(eventsFile)
      ? fs.readFileSync(eventsFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean)
      : [];
    const out = {
      replayed: true,
      runId,
      summary,
      events,
    };
    if (ctx.jsonMode) printJson(out);
    else {
      console.log(renderRecord({
        runId,
        datasource: summary.datasource || '',
        plugin: summary.plugin || '',
        capability: summary.capability || '',
        classification: summary.classification || '',
        durationMs: summary.timings?.durationMs || '',
        rowCount: Array.isArray(summary.result?.rows) ? summary.result.rows.length : '',
        eventCount: events.length,
      }));
      const tail = events.slice(-5).map((line, idx) => ({ idx: events.length - Math.min(5, events.length) + idx + 1, event: line }));
      if (tail.length) {
        console.log(renderTable(tail));
      }
    }
  });

  l.command('refresh-schema')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--service <service>')
    .action(async (opts) => {
      const ctx = getCtx();
      const datasource = await resolveDatasource(ctx, opts);
      if (!datasource) throw new Error('Datasource resolution failed. Use --datasource or --env+--service.');
      const refreshed = await refreshSchemaForDatasource(ctx, datasource);
      if (ctx.jsonMode) {
        printJson({
          datasource: datasource.name,
          database: refreshed.database,
          source: refreshed.source,
          tables: refreshed.tables,
          joins: refreshed.joins,
        });
      } else {
        console.log(renderRecord({
          datasource: datasource.name,
          database: refreshed.database,
          source: refreshed.source,
          tableCount: refreshed.tables.length,
          joinCount: refreshed.joins.length,
        }));
      }
    });

  l.command('tables')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--service <service>')
    .option('--limit <n>', 'max rows', '200')
    .action(async (opts) => {
      const ctx = getCtx();
      const datasource = await resolveDatasource(ctx, opts);
      const rows = ctx.learningStore.schemaTables(datasource?.name || undefined);
      const limit = Math.max(1, Number(opts.limit || 200));
      const sliced = rows
        .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
        .slice(0, limit);
      const state = emptyState({ datasource, rows: sliced, kind: 'tables', unresolved: Boolean((opts.datasource || opts.env || opts.service) && !datasource) });
      if (ctx.jsonMode) {
        printJson({ datasource: datasource?.name || null, rows: sliced, emptyReason: state.emptyReason, suggestedNextCommand: state.suggestedNextCommand });
      } else {
        if (!sliced.length) {
          printEmptyState('tables', state);
          return;
        }
        console.log(renderTable(sliced.map((r) => ({
          datasource: r.datasource,
          table: r.table,
          columns: r.columns.length,
          sightings: r.sightings,
          confidence: r.confidence.toFixed(2),
          source: (r.sources || []).join(','),
          lastSeenAt: r.lastSeenAt,
        }))));
      }
    });

  l.command('joins')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--service <service>')
    .option('--limit <n>', 'max rows', '200')
    .action(async (opts) => {
      const ctx = getCtx();
      const datasource = await resolveDatasource(ctx, opts);
      const rows = ctx.learningStore.schemaJoins(datasource?.name || undefined);
      const limit = Math.max(1, Number(opts.limit || 200));
      const sliced = rows
        .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
        .slice(0, limit);
      const state = emptyState({ datasource, rows: sliced, kind: 'joins', unresolved: Boolean((opts.datasource || opts.env || opts.service) && !datasource) });
      if (ctx.jsonMode) {
        printJson({ datasource: datasource?.name || null, rows: sliced, emptyReason: state.emptyReason, suggestedNextCommand: state.suggestedNextCommand });
      } else {
        if (!sliced.length) {
          printEmptyState('joins', state);
          return;
        }
        console.log(renderTable(sliced.map((r) => ({
          datasource: r.datasource,
          edge: `${r.leftTable} -> ${r.rightTable}`,
          condition: r.conditionNormalized,
          sightings: r.sightings,
          confidence: r.confidence.toFixed(2),
          source: (r.sources || []).join(','),
          lastSeenAt: r.lastSeenAt,
        }))));
      }
    });

  l.command('shapes')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--service <service>')
    .option('--limit <n>', 'max rows', '200')
    .action(async (opts) => {
      const ctx = getCtx();
      const datasource = await resolveDatasource(ctx, opts);
      const rows = ctx.learningStore.schemaQueryShapes(datasource?.name || undefined);
      const limit = Math.max(1, Number(opts.limit || 200));
      const sliced = rows
        .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
        .slice(0, limit);
      const state = emptyState({ datasource, rows: sliced, kind: 'shapes', unresolved: Boolean((opts.datasource || opts.env || opts.service) && !datasource) });
      if (ctx.jsonMode) {
        printJson({ datasource: datasource?.name || null, rows: sliced, emptyReason: state.emptyReason, suggestedNextCommand: state.suggestedNextCommand });
      } else {
        if (!sliced.length) {
          printEmptyState('shapes', state);
          return;
        }
        console.log(renderTable(sliced.map((r) => ({
          datasource: r.datasource,
          operation: r.operation,
          tables: r.tables.join(','),
          joins: r.joins.length,
          sightings: r.sightings,
          confidence: r.confidence.toFixed(2),
          source: (r.sources || []).join(','),
          lastSeenAt: r.lastSeenAt,
        }))));
      }
    });
}
