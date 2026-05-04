import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../core/app.js';
import { normalizeNamespace, normalizeService } from '../core/app.js';
import { bootstrapDatasource } from '../core/bootstrap.js';
import { printJson, renderRecord, renderTable } from '../core/output.js';
import { refreshSchemaForDatasource, supportsSchemaRefresh } from '../core/schema-refresh.js';
import type { DatasourceProfile } from '../types/core.js';
import { schemaObservationHasCurrentMetadata, type SchemaJoinEntry, type SchemaObservationEntry } from '../store/learning.js';

async function resolveDatasource(ctx: AppContext, opts: { datasource?: string; env?: string; namespace?: string; service?: string }): Promise<DatasourceProfile | undefined> {
  if (opts.datasource) return ctx.datasourceStore.get(String(opts.datasource));
  const env = String(opts.env || '').trim();
  const namespace = normalizeNamespace(String(opts.namespace || ''));
  const service = normalizeService(String(opts.service || ''), ctx.runtimeConfigStore.serviceAliases());
  if (!env || !service) return undefined;
  const ds = ctx.datasourceStore.resolveByEnvService(env, service, namespace || undefined);
  if (ds) return ds;
  const bootstrapped = await bootstrapDatasource(ctx, env, service, `${env}-${service}`, namespace || undefined);
  return bootstrapped?.profile;
}

function isTargetedRequest(opts: { datasource?: string; env?: string; namespace?: string; service?: string }): boolean {
  return Boolean(opts.datasource || opts.env || opts.namespace || opts.service);
}

function unresolvedNextCommand(opts: { datasource?: string; env?: string; namespace?: string; service?: string }): string | null {
  const datasource = String(opts.datasource || '').trim();
  if (datasource) return `taproot --json datasource show --name ${datasource}`;
  const env = String(opts.env || '').trim();
  const namespace = normalizeNamespace(String(opts.namespace || ''));
  const service = String(opts.service || '').trim();
  if (env && service) return `taproot --json init datasource --env ${env}${namespace ? ` --namespace ${namespace}` : ''} --service ${service}`;
  return null;
}

function scopedRows<T>(input: { datasource?: DatasourceProfile; targeted: boolean; load: (datasourceName?: string) => T[] }): T[] {
  if (input.datasource) return input.load(input.datasource.name);
  if (input.targeted) return [];
  return input.load(undefined);
}

function emptyState(input: {
  datasource?: DatasourceProfile;
  rows: unknown[];
  kind: 'tables' | 'joins' | 'shapes';
  unresolved?: boolean;
  suggestedNextCommand?: string | null;
}): { emptyReason: string | null; suggestedNextCommand: string | null } {
  if (input.rows.length) return { emptyReason: null, suggestedNextCommand: null };
  if (input.unresolved) return { emptyReason: 'datasource_unresolved', suggestedNextCommand: input.suggestedNextCommand || null };
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

function buildSchemaSnapshot(input: { tables: SchemaObservationEntry[]; joins: SchemaJoinEntry[]; limit: number }) {
  const tables = [...input.tables]
    .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
    .slice(0, input.limit)
    .map((row) => ({
      datasource: row.datasource,
      table: row.table,
      database: row.database,
      columns: row.columns.map((column) => column.column),
      columnStats: row.columns,
      primaryKey: row.primaryKey || [],
      indexes: row.indexes || [],
      partition: row.partition,
      metadataVersion: row.metadataVersion,
      sightings: row.sightings,
      confidence: row.confidence,
      source: row.sources,
      lastSeenAt: row.lastSeenAt,
    }));

  const visibleTables = new Set(tables.map((row) => row.table));
  const joins = [...input.joins]
    .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
    .filter((row) => visibleTables.size === 0 || visibleTables.has(row.leftTable) || visibleTables.has(row.rightTable))
    .slice(0, input.limit)
    .map((row) => ({
      datasource: row.datasource,
      leftTable: row.leftTable,
      rightTable: row.rightTable,
      condition: row.conditionNormalized,
      sightings: row.sightings,
      confidence: row.confidence,
      source: row.sources,
      lastSeenAt: row.lastSeenAt,
    }));

  return { tables, joins };
}

export interface EnsureSchemaResult {
  datasource: string | null;
  tables: Array<ReturnType<typeof buildSchemaSnapshot>['tables'][number]>;
  joins: Array<ReturnType<typeof buildSchemaSnapshot>['joins'][number]>;
  emptyReason: string | null;
  suggestedNextCommand: string | null;
  ensuredBy: 'cached-learning' | 'refreshed-introspection' | 'unresolved' | 'empty';
}

function effectiveLearningTtlHours(ctx: AppContext): number {
  const cfg = (ctx.runtimeConfigStore as { get?: () => { defaults?: { learning?: { ttlHours?: number } } } }).get?.();
  const raw = cfg?.defaults?.learning?.ttlHours;
  return typeof raw === 'number' && Number.isFinite(raw) && raw > 0 ? raw : 0;
}

function isAllStale(rows: { lastSeenAt: string }[], ttlHours: number): boolean {
  if (!ttlHours || !rows.length) return false;
  const cutoff = Date.now() - ttlHours * 3600 * 1000;
  return rows.every((row) => {
    const seen = Date.parse(row.lastSeenAt);
    return Number.isFinite(seen) && seen < cutoff;
  });
}

function normalizeRequestedTable(value: string): string {
  return String(value || '').replace(/`/g, '').trim().split('.').pop() || '';
}

function filterRequestedTables(rows: SchemaObservationEntry[], tables?: string[]): SchemaObservationEntry[] {
  const requested = new Set((tables || []).map(normalizeRequestedTable).filter(Boolean));
  if (!requested.size) return rows;
  return rows.filter((row) => requested.has(normalizeRequestedTable(row.table)));
}

function hasMissingRequestedTables(rows: SchemaObservationEntry[], tables?: string[]): boolean {
  const requested = new Set((tables || []).map(normalizeRequestedTable).filter(Boolean));
  if (!requested.size) return false;
  const present = new Set(rows.map((row) => normalizeRequestedTable(row.table)));
  return [...requested].some((table) => !present.has(table));
}

export async function ensureSchemaSnapshot(
  ctx: AppContext,
  opts: {
    datasource?: string;
    env?: string;
    namespace?: string;
    service?: string;
    limit?: number | string;
    tables?: string[];
    metadataTimeoutMs?: number;
  },
): Promise<EnsureSchemaResult> {
  const datasource = await resolveDatasource(ctx, opts);
  const targeted = isTargetedRequest(opts);
  const limit = Math.max(1, Number(opts.limit || 50));
  const ttlHours = effectiveLearningTtlHours(ctx);
  const snapshotFromStore = () =>
    buildSchemaSnapshot({
      tables: filterRequestedTables(scopedRows({ datasource, targeted, load: (name) => ctx.learningStore.schemaTables(name) }), opts.tables),
      joins: scopedRows({ datasource, targeted, load: (name) => ctx.learningStore.schemaJoins(name) }),
      limit,
    });

  let snapshot = snapshotFromStore();
  let state = emptyState({
    datasource,
    rows: snapshot.tables,
    kind: 'tables',
    unresolved: Boolean(targeted && !datasource),
    suggestedNextCommand: unresolvedNextCommand(opts),
  });

  const currentRows = filterRequestedTables(scopedRows({ datasource, targeted, load: (name) => ctx.learningStore.schemaTables(name) }), opts.tables);
  const stale = datasource && supportsSchemaRefresh(datasource) && isAllStale(snapshot.tables, ttlHours);
  const missingRequestedTables = hasMissingRequestedTables(currentRows, opts.tables);
  const incompleteMetadata = currentRows.some((row) => !schemaObservationHasCurrentMetadata(row));
  const shouldRefresh =
    Boolean(datasource) &&
    supportsSchemaRefresh(datasource) &&
    (state.emptyReason === 'schema_refresh_required' || (stale && !!snapshot.tables.length) || missingRequestedTables || incompleteMetadata);

  if (shouldRefresh && datasource) {
    await refreshSchemaForDatasource(ctx, datasource, {
      tables: opts.tables,
      metadataTimeoutMs: opts.metadataTimeoutMs,
    });
    snapshot = snapshotFromStore();
    state = emptyState({
      datasource,
      rows: snapshot.tables,
      kind: 'tables',
      unresolved: false,
      suggestedNextCommand: unresolvedNextCommand(opts),
    });
  }

  let ensuredBy: EnsureSchemaResult['ensuredBy'] = 'empty';
  if (state.emptyReason === 'datasource_unresolved') ensuredBy = 'unresolved';
  else if (snapshot.tables.length && state.emptyReason === null) {
    ensuredBy =
      shouldRefresh || snapshot.tables.some((row) => row.source.includes('refreshed-metadata'))
        ? 'refreshed-introspection'
        : 'cached-learning';
  }

  return {
    datasource: datasource?.name || null,
    tables: snapshot.tables,
    joins: snapshot.joins,
    emptyReason: state.emptyReason,
    suggestedNextCommand: state.suggestedNextCommand,
    ensuredBy,
  };
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
    .option('--namespace <namespace>')
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

  l.command('schema')
    .description('Show a compact learned schema snapshot for one datasource')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--namespace <namespace>')
    .option('--service <service>')
    .option('--limit <n>', 'max tables/joins', '50')
    .action(async (opts) => {
      const ctx = getCtx();
      const datasource = await resolveDatasource(ctx, opts);
      const targeted = isTargetedRequest(opts);
      const limit = Math.max(1, Number(opts.limit || 50));
      const allTables = scopedRows({ datasource, targeted, load: (name) => ctx.learningStore.schemaTables(name) });
      const allJoins = scopedRows({ datasource, targeted, load: (name) => ctx.learningStore.schemaJoins(name) });
      const snapshot = buildSchemaSnapshot({ tables: allTables, joins: allJoins, limit });
      const state = emptyState({
        datasource,
        rows: snapshot.tables,
        kind: 'tables',
        unresolved: Boolean(targeted && !datasource),
        suggestedNextCommand: unresolvedNextCommand(opts),
      });
      if (ctx.jsonMode) {
        printJson({
          datasource: datasource?.name || null,
          tables: snapshot.tables,
          joins: snapshot.joins,
          emptyReason: state.emptyReason,
          suggestedNextCommand: state.suggestedNextCommand,
        });
      } else {
        if (!snapshot.tables.length) {
          printEmptyState('tables', state);
          return;
        }
        console.log(renderTable(snapshot.tables.map((row) => ({
          datasource: row.datasource,
          table: row.table,
          columns: row.columns.join(','),
          sightings: row.sightings,
          confidence: row.confidence.toFixed(2),
          source: row.source.join(','),
          lastSeenAt: row.lastSeenAt,
        }))));
        if (snapshot.joins.length) {
          console.log('');
          console.log(renderTable(snapshot.joins.map((row) => ({
            datasource: row.datasource,
            edge: `${row.leftTable} -> ${row.rightTable}`,
            condition: row.condition,
            sightings: row.sightings,
            confidence: row.confidence.toFixed(2),
            source: row.source.join(','),
            lastSeenAt: row.lastSeenAt,
          }))));
        }
      }
    });

  l.command('ensure-schema')
    .description('Return learned schema for a datasource, introspecting once when learning is missing')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--namespace <namespace>')
    .option('--service <service>')
    .option('--limit <n>', 'max tables/joins', '50')
    .action(async (opts) => {
      const ctx = getCtx();
      const out = await ensureSchemaSnapshot(ctx, opts);
      if (ctx.jsonMode) {
        printJson(out);
      } else {
        if (!out.tables.length) {
          printEmptyState('tables', { emptyReason: out.emptyReason, suggestedNextCommand: out.suggestedNextCommand });
          return;
        }
        console.log(renderRecord({ datasource: out.datasource || '', ensuredBy: out.ensuredBy }));
        console.log(renderTable(out.tables.map((row) => ({
          datasource: row.datasource,
          table: row.table,
          columns: row.columns.join(','),
          sightings: row.sightings,
          confidence: row.confidence.toFixed(2),
          source: row.source.join(','),
          lastSeenAt: row.lastSeenAt,
        }))));
        if (out.joins.length) {
          console.log('');
          console.log(renderTable(out.joins.map((row) => ({
            datasource: row.datasource,
            edge: `${row.leftTable} -> ${row.rightTable}`,
            condition: row.condition,
            sightings: row.sightings,
            confidence: row.confidence.toFixed(2),
            source: row.source.join(','),
            lastSeenAt: row.lastSeenAt,
          }))));
        }
      }
    });

  l.command('tables')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--namespace <namespace>')
    .option('--service <service>')
    .option('--limit <n>', 'max rows', '200')
    .action(async (opts) => {
      const ctx = getCtx();
      const datasource = await resolveDatasource(ctx, opts);
      const targeted = isTargetedRequest(opts);
      const rows = scopedRows({ datasource, targeted, load: (name) => ctx.learningStore.schemaTables(name) });
      const limit = Math.max(1, Number(opts.limit || 200));
      const sliced = rows
        .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
        .slice(0, limit);
      const state = emptyState({
        datasource,
        rows: sliced,
        kind: 'tables',
        unresolved: Boolean(targeted && !datasource),
        suggestedNextCommand: unresolvedNextCommand(opts),
      });
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
    .option('--namespace <namespace>')
    .option('--service <service>')
    .option('--limit <n>', 'max rows', '200')
    .action(async (opts) => {
      const ctx = getCtx();
      const datasource = await resolveDatasource(ctx, opts);
      const targeted = isTargetedRequest(opts);
      const rows = scopedRows({ datasource, targeted, load: (name) => ctx.learningStore.schemaJoins(name) });
      const limit = Math.max(1, Number(opts.limit || 200));
      const sliced = rows
        .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
        .slice(0, limit);
      const state = emptyState({
        datasource,
        rows: sliced,
        kind: 'joins',
        unresolved: Boolean(targeted && !datasource),
        suggestedNextCommand: unresolvedNextCommand(opts),
      });
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
    .option('--namespace <namespace>')
    .option('--service <service>')
    .option('--limit <n>', 'max rows', '200')
    .action(async (opts) => {
      const ctx = getCtx();
      const datasource = await resolveDatasource(ctx, opts);
      const targeted = isTargetedRequest(opts);
      const rows = scopedRows({ datasource, targeted, load: (name) => ctx.learningStore.schemaQueryShapes(name) });
      const limit = Math.max(1, Number(opts.limit || 200));
      const sliced = rows
        .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
        .slice(0, limit);
      const state = emptyState({
        datasource,
        rows: sliced,
        kind: 'shapes',
        unresolved: Boolean(targeted && !datasource),
        suggestedNextCommand: unresolvedNextCommand(opts),
      });
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
