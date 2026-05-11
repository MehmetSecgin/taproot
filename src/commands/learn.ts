import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../core/app.js';
import { normalizeNamespace, normalizeService } from '../core/app.js';
import { bootstrapDatasource } from '../core/bootstrap.js';
import { printJson, printJsonPluck, renderRecord, renderTable } from '../core/output.js';
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

function scopedRows<T>(input: { datasource?: DatasourceProfile; targeted: boolean; load: (key?: string) => T[]; keyKind?: 'service' | 'datasource' }): T[] {
  if (input.datasource) {
    const kind = input.keyKind || 'service';
    const key = kind === 'service' ? String(input.datasource.service || '') : input.datasource.name;
    return input.load(key || undefined);
  }
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

type SchemaIndexProjection = {
  name: string;
  columns: string[];
  unique?: boolean;
  type?: string;
};

type TableSnapshot = {
  datasource: string;
  table: string;
  database: string;
  columns: string[];
  primaryKey: string[];
  indexes: SchemaIndexProjection[];
  partition?: SchemaObservationEntry['partition'];
  // detailed-only:
  columnStats?: SchemaObservationEntry['columns'];
  metadataVersion?: number;
  sightings?: number;
  confidence?: number;
  source?: SchemaObservationEntry['sources'];
  lastSeenAt?: string;
};

type JoinSnapshot = {
  leftTable: string;
  rightTable: string;
  condition: string;
  datasource?: string;
  sightings?: number;
  confidence?: number;
  source?: SchemaJoinEntry['sources'];
  lastSeenAt?: string;
};

function trimIndex(index: { name?: string; columns?: string[]; unique?: boolean; type?: string }): SchemaIndexProjection {
  const out: SchemaIndexProjection = {
    name: String(index.name || ''),
    columns: index.columns || [],
  };
  if (index.unique) out.unique = true;
  if (index.type && String(index.type).toUpperCase() !== 'BTREE') out.type = index.type;
  return out;
}

function buildSchemaSnapshot(input: { tables: SchemaObservationEntry[]; joins: SchemaJoinEntry[]; limit: number; detailed?: boolean }): { tables: TableSnapshot[]; joins: JoinSnapshot[] } {
  const detailed = Boolean(input.detailed);
  const tables: TableSnapshot[] = [...input.tables]
    .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
    .slice(0, input.limit)
    .map((row) => {
      const compact: TableSnapshot = {
        datasource: row.datasource,
        table: row.table,
        database: row.database,
        columns: row.columns.map((column) => column.column),
        primaryKey: row.primaryKey || [],
        indexes: (row.indexes || []).map(trimIndex),
        partition: row.partition,
      };
      if (!detailed) return compact;
      return {
        ...compact,
        columnStats: row.columns,
        metadataVersion: row.metadataVersion,
        sightings: row.sightings,
        confidence: row.confidence,
        source: row.sources,
        lastSeenAt: row.lastSeenAt,
      };
    });

  const visibleTables = new Set(tables.map((row) => row.table));
  const joins: JoinSnapshot[] = [...input.joins]
    .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
    .filter((row) => visibleTables.size === 0 || visibleTables.has(row.leftTable) || visibleTables.has(row.rightTable))
    .slice(0, input.limit)
    .map((row) => {
      const compact: JoinSnapshot = {
        leftTable: row.leftTable,
        rightTable: row.rightTable,
        condition: row.conditionNormalized,
      };
      if (!detailed) return compact;
      return {
        ...compact,
        datasource: row.datasource,
        sightings: row.sightings,
        confidence: row.confidence,
        source: row.sources,
        lastSeenAt: row.lastSeenAt,
      };
    });

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
    detailed?: boolean;
  },
): Promise<EnsureSchemaResult> {
  const datasource = await resolveDatasource(ctx, opts);
  const targeted = isTargetedRequest(opts);
  const limit = Math.max(1, Number(opts.limit || 50));
  const snapshotFromStore = () =>
    buildSchemaSnapshot({
      tables: filterRequestedTables(scopedRows({ datasource, targeted, load: (name) => ctx.learningStore.schemaTables(name) }), opts.tables),
      joins: scopedRows({ datasource, targeted, load: (name) => ctx.learningStore.schemaJoins(name) }),
      limit,
      detailed: Boolean(opts.detailed),
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
  const missingRequestedTables = hasMissingRequestedTables(currentRows, opts.tables);
  // Service-keyed cache: full refresh runs at most once per service. Subsequent calls return the cached schema.
  // Refresh triggers only when (a) no rows for this service, (b) requested tables are missing,
  // or (c) cached rows lack current introspection metadata (only observed by ad-hoc queries, never refreshed).
  // First-time introspection trigger: cache exists but no row has been properly refreshed yet.
  // Subsequent observed-only rows (CTE aliases, qualified-name dupes) do not force re-refresh.
  const hasAnyRefreshed = currentRows.some((row) => schemaObservationHasCurrentMetadata(row));
  const incompleteMetadata = currentRows.length > 0 && !hasAnyRefreshed;
  const shouldRefresh =
    Boolean(datasource) &&
    supportsSchemaRefresh(datasource) &&
    (state.emptyReason === 'schema_refresh_required' || missingRequestedTables || incompleteMetadata);

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
    ensuredBy = shouldRefresh ? 'refreshed-introspection' : 'cached-learning';
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
    .option('--detailed', 'include columnStats, sightings, confidence, source, and lastSeenAt', false)
    .option('--pluck <path>', 'return only the subtree at this dot-path (e.g. tables, joins, tables[0].indexes)')
    .action(async (opts) => {
      const ctx = getCtx();
      const datasource = await resolveDatasource(ctx, opts);
      const targeted = isTargetedRequest(opts);
      const limit = Math.max(1, Number(opts.limit || 50));
      const detailed = Boolean(opts.detailed);
      const allTables = scopedRows({ datasource, targeted, load: (name) => ctx.learningStore.schemaTables(name) });
      const allJoins = scopedRows({ datasource, targeted, load: (name) => ctx.learningStore.schemaJoins(name) });
      const snapshot = buildSchemaSnapshot({ tables: allTables, joins: allJoins, limit, detailed });
      const state = emptyState({
        datasource,
        rows: snapshot.tables,
        kind: 'tables',
        unresolved: Boolean(targeted && !datasource),
        suggestedNextCommand: unresolvedNextCommand(opts),
      });
      if (ctx.jsonMode) {
        printJsonPluck({
          datasource: datasource?.name || null,
          tables: snapshot.tables,
          joins: snapshot.joins,
          emptyReason: state.emptyReason,
          suggestedNextCommand: state.suggestedNextCommand,
        }, opts.pluck ? String(opts.pluck) : undefined);
      } else {
        if (!snapshot.tables.length) {
          printEmptyState('tables', state);
          return;
        }
        console.log(renderTable(snapshot.tables.map((row) => {
          const out: Record<string, unknown> = {
            datasource: row.datasource,
            table: row.table,
            columns: row.columns.length,
            indexes: row.indexes.length,
            primaryKey: row.primaryKey.join(','),
          };
          if (detailed) {
            out.sightings = row.sightings ?? '';
            out.confidence = row.confidence != null ? row.confidence.toFixed(2) : '';
            out.source = (row.source || []).join(',');
            out.lastSeenAt = row.lastSeenAt ?? '';
          }
          return out;
        })));
        if (snapshot.joins.length) {
          console.log('');
          console.log(renderTable(snapshot.joins.map((row) => {
            const out: Record<string, unknown> = {
              edge: `${row.leftTable} -> ${row.rightTable}`,
              condition: row.condition,
            };
            if (detailed) {
              out.datasource = row.datasource ?? '';
              out.sightings = row.sightings ?? '';
              out.confidence = row.confidence != null ? row.confidence.toFixed(2) : '';
              out.source = (row.source || []).join(',');
              out.lastSeenAt = row.lastSeenAt ?? '';
            }
            return out;
          })));
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
    .option('--detailed', 'include columnStats, sightings, confidence, source, and lastSeenAt', false)
    .option('--pluck <path>', 'return only the subtree at this dot-path (e.g. tables, joins, tables[0].indexes)')
    .action(async (opts) => {
      const ctx = getCtx();
      const detailed = Boolean(opts.detailed);
      const out = await ensureSchemaSnapshot(ctx, { ...opts, detailed });
      if (ctx.jsonMode) {
        printJsonPluck(out, opts.pluck ? String(opts.pluck) : undefined);
      } else {
        if (!out.tables.length) {
          printEmptyState('tables', { emptyReason: out.emptyReason, suggestedNextCommand: out.suggestedNextCommand });
          return;
        }
        console.log(renderRecord({ datasource: out.datasource || '', ensuredBy: out.ensuredBy }));
        console.log(renderTable(out.tables.map((row) => {
          const o: Record<string, unknown> = {
            datasource: row.datasource,
            table: row.table,
            columns: row.columns.length,
            indexes: row.indexes.length,
            primaryKey: row.primaryKey.join(','),
          };
          if (detailed) {
            o.sightings = row.sightings ?? '';
            o.confidence = row.confidence != null ? row.confidence.toFixed(2) : '';
            o.source = (row.source || []).join(',');
            o.lastSeenAt = row.lastSeenAt ?? '';
          }
          return o;
        })));
        if (out.joins.length) {
          console.log('');
          console.log(renderTable(out.joins.map((row) => {
            const o: Record<string, unknown> = {
              edge: `${row.leftTable} -> ${row.rightTable}`,
              condition: row.condition,
            };
            if (detailed) {
              o.datasource = row.datasource ?? '';
              o.sightings = row.sightings ?? '';
              o.confidence = row.confidence != null ? row.confidence.toFixed(2) : '';
              o.source = (row.source || []).join(',');
              o.lastSeenAt = row.lastSeenAt ?? '';
            }
            return o;
          })));
        }
      }
    });

  l.command('tables')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--namespace <namespace>')
    .option('--service <service>')
    .option('--limit <n>', 'max rows', '200')
    .option('--detailed', 'include columnStats, sightings, confidence, source, and lastSeenAt', false)
    .option('--pluck <path>', 'return only the subtree at this dot-path (e.g. tables, joins, tables[0].indexes)')
    .action(async (opts) => {
      const ctx = getCtx();
      const datasource = await resolveDatasource(ctx, opts);
      const targeted = isTargetedRequest(opts);
      const detailed = Boolean(opts.detailed);
      const rawRows = scopedRows({ datasource, targeted, load: (name) => ctx.learningStore.schemaTables(name) });
      const limit = Math.max(1, Number(opts.limit || 200));
      const sliced = rawRows
        .sort((a, b) => String(b.lastSeenAt).localeCompare(String(a.lastSeenAt)))
        .slice(0, limit);
      const state = emptyState({
        datasource,
        rows: sliced,
        kind: 'tables',
        unresolved: Boolean(targeted && !datasource),
        suggestedNextCommand: unresolvedNextCommand(opts),
      });
      const projected = sliced.map((r) => {
        const out: Record<string, unknown> = {
          datasource: r.datasource,
          table: r.table,
          database: r.database,
          columns: r.columns.map((c) => c.column),
          primaryKey: r.primaryKey || [],
          indexes: (r.indexes || []).map(trimIndex),
          partition: r.partition,
        };
        if (detailed) {
          out.columnStats = r.columns;
          out.metadataVersion = r.metadataVersion;
          out.sightings = r.sightings;
          out.confidence = r.confidence;
          out.source = r.sources;
          out.lastSeenAt = r.lastSeenAt;
        }
        return out;
      });
      if (ctx.jsonMode) {
        printJsonPluck({ datasource: datasource?.name || null, rows: projected, emptyReason: state.emptyReason, suggestedNextCommand: state.suggestedNextCommand }, opts.pluck ? String(opts.pluck) : undefined);
      } else {
        if (!sliced.length) {
          printEmptyState('tables', state);
          return;
        }
        console.log(renderTable(sliced.map((r) => {
          const out: Record<string, unknown> = {
            datasource: r.datasource,
            table: r.table,
            columns: r.columns.length,
            indexes: (r.indexes || []).length,
            primaryKey: (r.primaryKey || []).join(','),
          };
          if (detailed) {
            out.sightings = r.sightings;
            out.confidence = r.confidence.toFixed(2);
            out.source = (r.sources || []).join(',');
            out.lastSeenAt = r.lastSeenAt;
          }
          return out;
        })));
      }
    });

  l.command('joins')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--namespace <namespace>')
    .option('--service <service>')
    .option('--limit <n>', 'max rows', '200')
    .option('--detailed', 'include sightings, confidence, source, and lastSeenAt', false)
    .action(async (opts) => {
      const ctx = getCtx();
      const datasource = await resolveDatasource(ctx, opts);
      const targeted = isTargetedRequest(opts);
      const detailed = Boolean(opts.detailed);
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
      const projected = sliced.map((r) => {
        const out: Record<string, unknown> = {
          leftTable: r.leftTable,
          rightTable: r.rightTable,
          condition: r.conditionNormalized,
        };
        if (detailed) {
          out.datasource = r.datasource;
          out.sightings = r.sightings;
          out.confidence = r.confidence;
          out.source = r.sources;
          out.lastSeenAt = r.lastSeenAt;
        }
        return out;
      });
      if (ctx.jsonMode) {
        printJsonPluck({ datasource: datasource?.name || null, rows: projected, emptyReason: state.emptyReason, suggestedNextCommand: state.suggestedNextCommand }, opts.pluck ? String(opts.pluck) : undefined);
      } else {
        if (!sliced.length) {
          printEmptyState('joins', state);
          return;
        }
        console.log(renderTable(sliced.map((r) => {
          const out: Record<string, unknown> = {
            edge: `${r.leftTable} -> ${r.rightTable}`,
            condition: r.conditionNormalized,
          };
          if (detailed) {
            out.datasource = r.datasource;
            out.sightings = r.sightings;
            out.confidence = r.confidence.toFixed(2);
            out.source = (r.sources || []).join(',');
            out.lastSeenAt = r.lastSeenAt;
          }
          return out;
        })));
      }
    });

  l.command('shapes')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--namespace <namespace>')
    .option('--service <service>')
    .option('--limit <n>', 'max rows', '200')
    .option('--detailed', 'include normalizedSql, sightings, confidence, source, and lastSeenAt', false)
    .action(async (opts) => {
      const ctx = getCtx();
      const datasource = await resolveDatasource(ctx, opts);
      const targeted = isTargetedRequest(opts);
      const detailed = Boolean(opts.detailed);
      const rows = scopedRows({ datasource, targeted, load: (name) => ctx.learningStore.schemaQueryShapes(name), keyKind: 'datasource' });
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
      const projected = sliced.map((r) => {
        const out: Record<string, unknown> = {
          datasource: r.datasource,
          operation: r.operation,
          tables: r.tables,
          joins: r.joins,
        };
        if (detailed) {
          out.normalizedSql = r.normalizedSql;
          out.sightings = r.sightings;
          out.confidence = r.confidence;
          out.source = r.sources;
          out.lastSeenAt = r.lastSeenAt;
        }
        return out;
      });
      if (ctx.jsonMode) {
        printJsonPluck({ datasource: datasource?.name || null, rows: projected, emptyReason: state.emptyReason, suggestedNextCommand: state.suggestedNextCommand }, opts.pluck ? String(opts.pluck) : undefined);
      } else {
        if (!sliced.length) {
          printEmptyState('shapes', state);
          return;
        }
        console.log(renderTable(sliced.map((r) => {
          const out: Record<string, unknown> = {
            datasource: r.datasource,
            operation: r.operation,
            tables: r.tables.join(','),
            joins: r.joins.length,
          };
          if (detailed) {
            out.sightings = r.sightings;
            out.confidence = r.confidence.toFixed(2);
            out.source = (r.sources || []).join(',');
            out.lastSeenAt = r.lastSeenAt;
          }
          return out;
        })));
      }
    });
}
