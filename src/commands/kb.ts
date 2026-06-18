import { Command } from 'commander';
import fs from 'node:fs';
import type { AppContext } from '../core/app.js';
import { normalizeNamespace, normalizeService } from '../core/app.js';
import { printJson, printJsonPluck, renderRecord, renderTable } from '../core/output.js';
import { normalizeRelations, validateRelations } from '../core/relations.js';
import { str } from '../core/strings.js';

export function registerKb(program: Command, getCtx: () => AppContext): void {
  const kb = program.command('kb').description('Knowledge base resolvers');

  kb.command('resolve-connection').requiredOption('--service <service>').requiredOption('--env <env>').option('--namespace <namespace>').action((opts) => {
    const ctx = getCtx();
    const service = normalizeService(opts.service, ctx.runtimeConfigStore.serviceAliases());
    const namespace = normalizeNamespace(opts.namespace) || undefined;
    const out = ctx.kbStore.resolveConnection(service, opts.env, namespace);
    if (!out) {
      const svc = ctx.kbStore.services().find((s) => str(s.service).trim().toLowerCase() === service.toLowerCase());
      if (!svc) {
        const known = ctx.kbStore.listServices();
        throw new Error(`No KB connection match: service '${service}' is not registered in KB. Known services: ${known.slice(0, 10).join(', ')}${known.length > 10 ? ` (+${known.length - 10})` : ''}`);
      }
      const envs = Array.from(new Set((Array.isArray(svc.connections) ? svc.connections : [])
        .filter((c: any) => String(c.status || 'active') === 'active')
        .map((c: any) => `${String(c.env)}${c.namespace ? `/${c.namespace}` : ''}`))).sort();
      const nsHint = namespace ? ` namespace=${namespace}` : '';
      throw new Error(
        `No KB connection match: service '${service}' is registered but not for env=${opts.env}${nsHint}. Available: ${envs.join(', ') || '(none active)'}. Register this env with 'taproot datasource add --env ${opts.env} --service ${service} ...' or pick an available env.`,
      );
    }
    if (ctx.jsonMode) printJson(out);
    else console.log(renderRecord(out));
  });

  kb.command('resolve-credentials').requiredOption('--service <service>').requiredOption('--env <env>').option('--namespace <namespace>').action((opts) => {
    const ctx = getCtx();
    const service = normalizeService(opts.service, ctx.runtimeConfigStore.serviceAliases());
    const out = ctx.kbStore.resolveConnection(service, opts.env, normalizeNamespace(opts.namespace) || undefined);
    if (!out) throw new Error('No KB credentials match.');
    const rows = {
      service,
      env: opts.env,
      namespace: normalizeNamespace(opts.namespace) || undefined,
      target: out.target,
      database: out.database,
      db_user: out.db_user,
      engine: out.engine,
      access_method: out.access_method,
      verified_at_utc: out.verified_at_utc,
    };
    if (ctx.jsonMode) printJson(rows);
    else console.log(renderRecord(rows));
  });

  kb.command('resolve-database-name').requiredOption('--service <service>').requiredOption('--env <env>').option('--namespace <namespace>').action((opts) => {
    const ctx = getCtx();
    const service = normalizeService(opts.service, ctx.runtimeConfigStore.serviceAliases());
    const out = ctx.kbStore.resolveConnection(service, opts.env, normalizeNamespace(opts.namespace) || undefined);
    if (!out) throw new Error('No KB database match.');
    const row = { service, env: opts.env, namespace: normalizeNamespace(opts.namespace) || undefined, database: out.database, verified_at_utc: out.verified_at_utc };
    if (ctx.jsonMode) printJson(row);
    else console.log(renderRecord(row));
  });

  kb.command('resolve-query').requiredOption('--service <service>').requiredOption('--intent <intent>').action((opts) => {
    const ctx = getCtx();
    const service = normalizeService(opts.service, ctx.runtimeConfigStore.serviceAliases());
    const out = ctx.kbStore.resolveQuery(service, opts.intent);
    if (!out) throw new Error('No KB query template match.');
    if (ctx.jsonMode) printJson(out);
    else console.log(renderRecord(out));
  });

  kb.command('tables')
    .requiredOption('--service <service>')
    .option('--env <env>')
    .option('--text <text>', 'substring filter on table names (alias: --match)')
    .option('--match <text>', 'substring filter on table names (alias of --text)')
    .option('--list', 'render flat list of matching table names instead of per-database counts', false)
    .option('--pluck <path>', 'return only the subtree at this dot-path of the JSON output')
    .action((opts) => {
      const ctx = getCtx();
      const service = normalizeService(opts.service, ctx.runtimeConfigStore.serviceAliases());
      const matchText = str(opts.match || opts.text).trim();
      const rows = ctx.kbStore.tables().filter((r) => str(r.service).toLowerCase() === service.toLowerCase());
      const scoped = rows.filter((r) => !opts.env || String(r.env) === String(opts.env));
      const filtered = scoped.map((r) => ({
        ...r,
        tables: matchText ? (r.tables || []).filter((t: string) => t.toLowerCase().includes(matchText.toLowerCase())) : r.tables,
      }));
      if (ctx.jsonMode) {
        const payload = opts.list
          ? filtered.flatMap((r) => (r.tables || []).map((t: string) => ({ service: r.service, env: r.env, database: r.database, table: t })))
          : filtered;
        printJsonPluck(payload, opts.pluck ? String(opts.pluck) : undefined);
        return;
      }
      if (opts.list) {
        const flat = filtered.flatMap((r) => (r.tables || []).map((t: string) => ({
          service: str(r.service),
          env: str(r.env),
          database: str(r.database),
          table: t,
        })));
        console.log(renderTable(flat));
        return;
      }
      const tableRows = filtered.map((r) => ({
        service: str(r.service),
        env: str(r.env),
        database: str(r.database),
        tables: Array.isArray(r.tables) ? r.tables.length : 0,
      }));
      console.log(renderTable(tableRows));
    });

  kb.command('related')
    .description('Show curated cross-service and intra-service relations touching a service')
    .requiredOption('--service <service>')
    .option('--cross-service', 'only relations that cross a service boundary', false)
    .option('--pluck <path>', 'return only the subtree at this dot-path of the JSON output')
    .action((opts) => {
      const ctx = getCtx();
      const s = normalizeService(opts.service, ctx.runtimeConfigStore.serviceAliases()).toLowerCase();
      let rows = ctx.kbStore
        .typedRelations()
        .filter((r) => r.from.service.toLowerCase() === s || r.to.service.toLowerCase() === s);
      if (opts.crossService) rows = rows.filter((r) => r.from.service.toLowerCase() !== r.to.service.toLowerCase());
      if (ctx.jsonMode) {
        printJsonPluck(rows, opts.pluck ? String(opts.pluck) : undefined);
      } else if (!rows.length) {
        console.log(`No curated relations for service '${opts.service}'. Derive candidates with "taproot learn relations --service ${opts.service}".`);
      } else {
        const tableRows = rows.map((r) => ({
          from: `${r.from.service}.${r.from.table}.${r.from.column}`,
          to: `${r.to.service}.${r.to.table}.${r.to.column}`,
          relationship: r.relationship || '',
          cross: r.from.service.toLowerCase() !== r.to.service.toLowerCase() ? 'yes' : '',
          notes: r.notes || '',
        }));
        console.log(renderTable(tableRows));
      }
    });

  const relations = kb.command('relations').description('Curated cross-service relation operations');

  relations.command('list')
    .description('List all curated relations in the KB')
    .option('--cross-service', 'only relations that cross a service boundary', false)
    .option('--pluck <path>', 'return only the subtree at this dot-path of the JSON output')
    .action((opts) => {
      const ctx = getCtx();
      let rows = ctx.kbStore.typedRelations();
      if (opts.crossService) rows = rows.filter((r) => r.from.service.toLowerCase() !== r.to.service.toLowerCase());
      if (ctx.jsonMode) {
        printJsonPluck(rows, opts.pluck ? String(opts.pluck) : undefined);
      } else if (!rows.length) {
        console.log('No curated relations. Import a map with "taproot kb relations import --file <path>".');
      } else {
        console.log(renderTable(rows.map((r) => ({
          from: `${r.from.service}.${r.from.table}.${r.from.column}`,
          to: `${r.to.service}.${r.to.table}.${r.to.column}`,
          relationship: r.relationship || '',
          cross: r.from.service.toLowerCase() !== r.to.service.toLowerCase() ? 'yes' : '',
        }))));
      }
    });

  relations.command('validate')
    .description('Check curated relation endpoints against the learned schema cache; reports ok/stale/unknown')
    .option('--service <service>', 'only relations touching this service')
    .option('--stale-only', 'only show edges whose table/column no longer exists', false)
    .option('--pluck <path>', 'return only the subtree at this dot-path of the JSON output')
    .action((opts) => {
      const ctx = getCtx();
      let rels = ctx.kbStore.typedRelations();
      if (opts.service) {
        const s = normalizeService(String(opts.service), ctx.runtimeConfigStore.serviceAliases()).toLowerCase();
        rels = rels.filter((r) => r.from.service.toLowerCase() === s || r.to.service.toLowerCase() === s);
      }
      let results = validateRelations(rels, ctx.learningStore.schemaTables());
      if (opts.staleOnly) results = results.filter((r) => r.stale);
      const summary = {
        total: results.length,
        stale: results.filter((r) => r.stale).length,
        unknown: results.filter((r) => !r.stale && (r.fromStatus === 'unknown_service' || r.toStatus === 'unknown_service')).length,
      };
      if (ctx.jsonMode) {
        printJsonPluck({ summary, results }, opts.pluck ? String(opts.pluck) : undefined);
      } else if (!results.length) {
        console.log('No relations to validate.');
      } else {
        console.log(renderTable(results.map((r) => ({
          from: r.from,
          to: r.to,
          fromStatus: r.fromStatus,
          toStatus: r.toStatus,
          stale: r.stale ? 'STALE' : '',
        }))));
        console.log(`\n${summary.total} relation(s): ${summary.stale} stale, ${summary.unknown} unverifiable (service not introspected).`);
        if (summary.stale) console.log('Stale edges still inject (marked stale) — re-verify against current schema and re-import or edit relations.json.');
      }
    });

  relations.command('import')
    .description('Merge a JSON file of curated relations into KB relations.json (dedup by id)')
    .requiredOption('--file <path>', 'path to a JSON array of relation objects')
    .action((opts) => {
      const ctx = getCtx();
      const file = String(opts.file);
      if (!fs.existsSync(file)) throw new Error(`Relations file not found: ${file}`);
      let parsed: unknown;
      try {
        parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      } catch (error) {
        throw new Error(`Invalid JSON in ${file}: ${(error as Error).message}`);
      }
      if (!Array.isArray(parsed)) throw new Error('Relations file must be a JSON array of relation objects.');
      const normalized = normalizeRelations(parsed);
      const skipped = parsed.length - normalized.length;
      const result = ctx.kbStore.promoteRelations(normalized);
      if (ctx.jsonMode) {
        printJson({ ok: true, data: { added: result.added, total: result.total, skipped }, meta: {} });
      } else {
        console.log(`Imported ${result.added} new relation(s) (${normalized.length} valid, ${skipped} skipped). relations.json now holds ${result.total}.`);
      }
    });

  kb.command('list-services')
    .option('--pluck <path>', 'return only the subtree at this dot-path of the JSON output')
    .action((opts) => {
      const ctx = getCtx();
      const rows = ctx.kbStore.listServices();
      if (ctx.jsonMode) printJsonPluck(rows, opts.pluck ? String(opts.pluck) : undefined);
      else console.log(renderTable(rows.map((service) => ({ service }))));
    });
}
