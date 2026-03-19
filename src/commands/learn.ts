import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../core/app.js';
import { normalizeService } from '../core/app.js';
import { printJson, renderRecord, renderTable } from '../core/output.js';

function resolveDatasourceName(ctx: AppContext, opts: { datasource?: string; env?: string; service?: string }): string {
  if (opts.datasource) return String(opts.datasource);
  const env = String(opts.env || '').trim();
  const service = normalizeService(String(opts.service || ''), ctx.runtimeConfigStore.serviceAliases());
  if (!env || !service) return '';
  const ds = ctx.datasourceStore.resolveByEnvService(env, service);
  return ds?.name || '';
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

  l.command('tables')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--service <service>')
    .option('--limit <n>', 'max rows', '200')
    .action((opts) => {
      const ctx = getCtx();
      const datasource = resolveDatasourceName(ctx, opts);
      const rows = ctx.learningStore.schemaTables(datasource || undefined);
      const limit = Math.max(1, Number(opts.limit || 200));
      const sliced = rows
        .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
        .slice(0, limit);
      if (ctx.jsonMode) {
        printJson({ datasource: datasource || null, rows: sliced });
      } else {
        console.log(
          renderTable(
            sliced.map((r) => ({
              datasource: r.datasource,
              table: r.table,
              columns: r.columns.length,
              sightings: r.sightings,
              confidence: r.confidence.toFixed(2),
              lastSeenAt: r.lastSeenAt,
            })),
          ),
        );
      }
    });

  l.command('joins')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--service <service>')
    .option('--limit <n>', 'max rows', '200')
    .action((opts) => {
      const ctx = getCtx();
      const datasource = resolveDatasourceName(ctx, opts);
      const rows = ctx.learningStore.schemaJoins(datasource || undefined);
      const limit = Math.max(1, Number(opts.limit || 200));
      const sliced = rows
        .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
        .slice(0, limit);
      if (ctx.jsonMode) {
        printJson({ datasource: datasource || null, rows: sliced });
      } else {
        console.log(
          renderTable(
            sliced.map((r) => ({
              datasource: r.datasource,
              edge: `${r.leftTable} -> ${r.rightTable}`,
              condition: r.conditionNormalized,
              sightings: r.sightings,
              confidence: r.confidence.toFixed(2),
              lastSeenAt: r.lastSeenAt,
            })),
          ),
        );
      }
    });

  l.command('shapes')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--service <service>')
    .option('--limit <n>', 'max rows', '200')
    .action((opts) => {
      const ctx = getCtx();
      const datasource = resolveDatasourceName(ctx, opts);
      const rows = ctx.learningStore.schemaQueryShapes(datasource || undefined);
      const limit = Math.max(1, Number(opts.limit || 200));
      const sliced = rows
        .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
        .slice(0, limit);
      if (ctx.jsonMode) {
        printJson({ datasource: datasource || null, rows: sliced });
      } else {
        console.log(
          renderTable(
            sliced.map((r) => ({
              datasource: r.datasource,
              operation: r.operation,
              tables: r.tables.join(','),
              joins: r.joins.length,
              sightings: r.sightings,
              confidence: r.confidence.toFixed(2),
              lastSeenAt: r.lastSeenAt,
            })),
          ),
        );
      }
    });
}
