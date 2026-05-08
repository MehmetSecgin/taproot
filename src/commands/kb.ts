import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { normalizeNamespace, normalizeService } from '../core/app.js';
import { printJson, renderRecord, renderTable } from '../core/output.js';

export function registerKb(program: Command, getCtx: () => AppContext): void {
  const kb = program.command('kb').description('Knowledge base resolvers');

  kb.command('resolve-connection').requiredOption('--service <service>').requiredOption('--env <env>').option('--namespace <namespace>').action((opts) => {
    const ctx = getCtx();
    const service = normalizeService(opts.service, ctx.runtimeConfigStore.serviceAliases());
    const namespace = normalizeNamespace(opts.namespace) || undefined;
    const out = ctx.kbStore.resolveConnection(service, opts.env, namespace);
    if (!out) {
      const svc = ctx.kbStore.services().find((s) => String(s.service || '').trim().toLowerCase() === service.toLowerCase());
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
    .action((opts) => {
      const ctx = getCtx();
      const service = normalizeService(opts.service, ctx.runtimeConfigStore.serviceAliases());
      const matchText = String(opts.match || opts.text || '').trim();
      const rows = ctx.kbStore.tables().filter((r) => String(r.service || '').toLowerCase() === service.toLowerCase());
      const scoped = rows.filter((r) => !opts.env || String(r.env) === String(opts.env));
      const filtered = scoped.map((r) => ({
        ...r,
        tables: matchText ? (r.tables || []).filter((t: string) => t.toLowerCase().includes(matchText.toLowerCase())) : r.tables,
      }));
      if (ctx.jsonMode) {
        printJson(opts.list
          ? filtered.flatMap((r) => (r.tables || []).map((t: string) => ({ service: r.service, env: r.env, database: r.database, table: t })))
          : filtered);
        return;
      }
      if (opts.list) {
        const flat = filtered.flatMap((r) => (r.tables || []).map((t: string) => ({
          service: String(r.service || ''),
          env: String(r.env || ''),
          database: String(r.database || ''),
          table: t,
        })));
        console.log(renderTable(flat));
        return;
      }
      const tableRows = filtered.map((r) => ({
        service: String(r.service || ''),
        env: String(r.env || ''),
        database: String(r.database || ''),
        tables: Array.isArray(r.tables) ? r.tables.length : 0,
      }));
      console.log(renderTable(tableRows));
    });

  kb.command('related').requiredOption('--service <service>').action((opts) => {
    const ctx = getCtx();
    const s = normalizeService(opts.service, ctx.runtimeConfigStore.serviceAliases()).toLowerCase();
    const rows = ctx.kbStore.relations().filter((r) => String(r?.from?.service || '').toLowerCase() === s || String(r?.to?.service || '').toLowerCase() === s);
    if (ctx.jsonMode) printJson(rows);
    else {
      const tableRows = rows.map((r) => ({
        from: `${String(r?.from?.service || '')}.${String(r?.from?.table || '')}`,
        to: `${String(r?.to?.service || '')}.${String(r?.to?.table || '')}`,
        via: String(r?.via || ''),
      }));
      console.log(renderTable(tableRows));
    }
  });

  kb.command('list-services').action(() => {
    const ctx = getCtx();
    const rows = ctx.kbStore.listServices();
    if (ctx.jsonMode) printJson(rows);
    else console.log(renderTable(rows.map((service) => ({ service }))));
  });
}
