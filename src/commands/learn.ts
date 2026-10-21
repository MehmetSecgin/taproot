import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../core/app.js';
import { normalizeService, runDatasourceConnectors } from '../core/app.js';
import { connectivity } from '../core/error-classification.js';
import { printJson } from '../core/output.js';
import { refreshGrpcSchemaForDatasource, refreshSchemaForDatasource } from '../core/schema-refresh.js';
import { deriveRelationCandidates, validateRelations } from '../core/relations.js';
import { describeResolutionFailure } from '../core/resolve-datasource.js';
import { DatasourceKind, DoctorStatus } from '../types/core.js';
import { str } from '../core/strings.js';
import { emptyState, isTargetedRequest, resolveDatasource, scopedRows, unresolvedNextCommand } from './learn-common.js';
import { buildSchemaSnapshot, ensureSchemaSnapshot, trimIndex } from './learn-sql.js';
import { ensureGrpcSchemaSnapshot, readGrpcSchemaSnapshot } from './learn-grpc.js';

export { ensureSchemaSnapshot } from './learn-sql.js';
export type { EnsureSchemaResult } from './learn-sql.js';
export { ensureGrpcSchemaSnapshot } from './learn-grpc.js';
export type { GrpcMethodRow, GrpcSchemaSnapshot } from './learn-grpc.js';

export function registerLearn(program: Command, getCtx: () => AppContext): void {
  const l = program.command('learn').description('Learning cache operations');

  l.command('status').action(() => {
    const ctx = getCtx();
    const status = ctx.learningStore.status();
    printJson(status);
  });

  l.command('compact').action(() => {
    const ctx = getCtx();
    const out = ctx.learningStore.compact();
    printJson(out);
  });

  l.command('replay').requiredOption('--run-id <id>').action((opts) => {
    const ctx = getCtx();
    const runId = str(opts.runId).trim();
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
    printJson(out);
  });

  l.command('refresh-schema')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--namespace <namespace>')
    .option('--service <service>')
    .action(async (opts) => {
      const ctx = getCtx();
      const datasource = await resolveDatasource(ctx, opts);
      if (!datasource) throw new Error(describeResolutionFailure(ctx.datasourceStore.list(), { rawDs: opts.datasource, env: opts.env, namespace: opts.namespace, service: opts.service }));
      if (datasource.kind === DatasourceKind.Grpc) {
        const refreshed = await refreshGrpcSchemaForDatasource(ctx, datasource);
        const methodCount = refreshed.services.reduce((acc, s) => acc + s.methods.length, 0);
        printJson({
          datasource: refreshed.datasource,
          protoRoot: refreshed.protoRoot,
          source: 'proto-introspection',
          services: refreshed.services.length,
          methods: methodCount,
          messages: Object.keys(refreshed.messages).length,
          enums: Object.keys(refreshed.enums).length,
        });
        return;
      }
      try {
        const connectorChecks = await runDatasourceConnectors({
          datasource,
          credentialStore: ctx.credentialStore,
          pluginRegistry: ctx.pluginRegistry,
          mode: 'doctor',
        });
        const failures = connectorChecks.filter((check) => check.status === DoctorStatus.Fail);
        if (failures.length) {
          const detail = failures.map((c) => `${c.check}: ${c.detail}`).join(' | ');
          throw connectivity(`${detail}; ensure VPN/teleport/telepresence are up before retrying`, {
            failures,
            nextCommand: `taproot doctor --datasource ${datasource.name} --connect`,
          });
        }
      } catch (error) {
        const e = error as Error & { code?: string };
        if (e.code === 'CONNECTIVITY') throw e;
      }
      const refreshed = await refreshSchemaForDatasource(ctx, datasource);
      const service = str(datasource.service).toLowerCase();
      const serviceRelations = service
        ? ctx.kbStore.typedRelations().filter((r) => r.from.service.toLowerCase() === service || r.to.service.toLowerCase() === service)
        : [];
      const staleRelations = validateRelations(serviceRelations, ctx.learningStore.schemaTables()).filter((r) => r.stale);
      printJson({
        datasource: datasource.name,
        database: refreshed.database,
        source: refreshed.source,
        tables: refreshed.tables,
        joins: refreshed.joins,
        staleRelations,
      });
    });

  l.command('schema')
    .description('Show a compact learned schema snapshot for one datasource')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--namespace <namespace>')
    .option('--service <service>')
    .option('--limit <n>', 'max tables/joins', '50')
    .option('--detailed', 'include columnStats, sightings, confidence, source, and lastSeenAt', false)
    .action(async (opts) => {
      const ctx = getCtx();
      const datasource = await resolveDatasource(ctx, opts);
      const targeted = isTargetedRequest(opts);
      if (datasource?.kind === DatasourceKind.Grpc) {
        const snapshot = readGrpcSchemaSnapshot(ctx, datasource, targeted, { ...opts, detailed: Boolean(opts.detailed) });
        printJson(snapshot);
        return;
      }
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
        suggestedNextCommand: unresolvedNextCommand(opts, ctx),
      });
      printJson({
        datasource: datasource?.name || null,
        tables: snapshot.tables,
        joins: snapshot.joins,
        emptyReason: state.emptyReason,
        suggestedNextCommand: state.suggestedNextCommand,
      });
    });

  l.command('ensure-schema')
    .description('Return learned schema for a datasource, introspecting once when learning is missing')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--namespace <namespace>')
    .option('--service <service>')
    .option('--limit <n>', 'max tables/joins', '50')
    .option('--detailed', 'include columnStats, sightings, confidence, source, and lastSeenAt', false)
    .option('--refresh', 'force a fresh introspection even when the service schema cache is already populated (use after migrations that change columns or indexes)', false)
    .action(async (opts) => {
      const ctx = getCtx();
      const detailed = Boolean(opts.detailed);
      const preResolved = await resolveDatasource(ctx, opts);
      if (preResolved?.kind === DatasourceKind.Grpc) {
        const snapshot = await ensureGrpcSchemaSnapshot(ctx, { ...opts, detailed, refresh: Boolean(opts.refresh) });
        printJson(snapshot);
        return;
      }
      const out = await ensureSchemaSnapshot(ctx, { ...opts, detailed, refresh: Boolean(opts.refresh) });
      printJson(out);
    });

  l.command('tables')
    .option('--datasource <name>')
    .option('--env <env>')
    .option('--namespace <namespace>')
    .option('--service <service>')
    .option('--limit <n>', 'max rows', '200')
    .option('--detailed', 'include columnStats, sightings, confidence, source, and lastSeenAt', false)
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
        suggestedNextCommand: unresolvedNextCommand(opts, ctx),
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
      printJson({ datasource: datasource?.name || null, rows: projected, emptyReason: state.emptyReason, suggestedNextCommand: state.suggestedNextCommand });
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
        suggestedNextCommand: unresolvedNextCommand(opts, ctx),
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
      printJson({ datasource: datasource?.name || null, rows: projected, emptyReason: state.emptyReason, suggestedNextCommand: state.suggestedNextCommand });
    });

  l.command('relations')
    .description('Derive candidate cross-service relations from learned schemas; --promote writes confirmed ones into KB relations.json')
    .option('--service <service>', 'only candidates touching this service')
    .option('--min-confidence <n>', 'drop candidates scoring below this threshold', '0')
    .option('--include-existing', 'also include candidates already present in relations.json', false)
    .option('--promote', 'write the listed candidates into KB relations.json (marked source=derived)', false)
    .option('--limit <n>', 'max rows', '100')
    .action((opts) => {
      const ctx = getCtx();
      const existingIds = new Set(ctx.kbStore.typedRelations().map((rel) => rel.id));
      let candidates = deriveRelationCandidates(ctx.learningStore.schemaTables());
      if (!opts.includeExisting) candidates = candidates.filter((c) => !existingIds.has(c.id));
      const minConfidence = Number(opts.minConfidence || 0);
      if (minConfidence > 0) candidates = candidates.filter((c) => (c.confidence || 0) >= minConfidence);
      if (opts.service) {
        const s = normalizeService(String(opts.service), ctx.runtimeConfigStore.serviceAliases()).toLowerCase();
        candidates = candidates.filter((c) => c.from.service.toLowerCase() === s || c.to.service.toLowerCase() === s);
      }
      const limit = Math.max(1, Number(opts.limit || 100));
      candidates = candidates.slice(0, limit);
      const promoted = opts.promote && candidates.length ? ctx.kbStore.promoteRelations(candidates) : null;
      printJson({ candidates, promoted });
    });
}
