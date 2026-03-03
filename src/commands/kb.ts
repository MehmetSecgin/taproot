import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { printJson, renderRecord, renderTable } from '../core/output.js';

export function registerKb(program: Command, getCtx: () => AppContext): void {
  const kb = program.command('kb').description('Knowledge base resolvers');

  kb.command('resolve-connection').requiredOption('--service <service>').requiredOption('--env <env>').action((opts) => {
    const ctx = getCtx();
    const out = ctx.kbStore.resolveConnection(opts.service, opts.env);
    if (!out) throw new Error('No KB connection match.');
    if (ctx.jsonMode) printJson(out);
    else console.log(renderRecord(out));
  });

  kb.command('resolve-credentials').requiredOption('--service <service>').requiredOption('--env <env>').action((opts) => {
    const ctx = getCtx();
    const out = ctx.kbStore.resolveConnection(opts.service, opts.env);
    if (!out) throw new Error('No KB credentials match.');
    const rows = {
      service: opts.service,
      env: opts.env,
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

  kb.command('resolve-database-name').requiredOption('--service <service>').requiredOption('--env <env>').action((opts) => {
    const ctx = getCtx();
    const out = ctx.kbStore.resolveConnection(opts.service, opts.env);
    if (!out) throw new Error('No KB database match.');
    const row = { service: opts.service, env: opts.env, database: out.database, verified_at_utc: out.verified_at_utc };
    if (ctx.jsonMode) printJson(row);
    else console.log(renderRecord(row));
  });

  kb.command('resolve-query').requiredOption('--service <service>').requiredOption('--intent <intent>').action((opts) => {
    const ctx = getCtx();
    const out = ctx.kbStore.resolveQuery(opts.service, opts.intent);
    if (!out) throw new Error('No KB query template match.');
    if (ctx.jsonMode) printJson(out);
    else console.log(renderRecord(out));
  });

  kb.command('tables').requiredOption('--service <service>').option('--env <env>').option('--text <text>').action((opts) => {
    const ctx = getCtx();
    const rows = ctx.kbStore.tables().filter((r) => String(r.service || '').toLowerCase() === String(opts.service).toLowerCase());
    const scoped = rows.filter((r) => !opts.env || String(r.env) === String(opts.env));
    const filtered = scoped.map((r) => ({ ...r, tables: opts.text ? (r.tables || []).filter((t: string) => t.toLowerCase().includes(String(opts.text).toLowerCase())) : r.tables }));
    if (ctx.jsonMode) printJson(filtered);
    else {
      const tableRows = filtered.map((r) => ({
        service: String(r.service || ''),
        env: String(r.env || ''),
        database: String(r.database || ''),
        tables: Array.isArray(r.tables) ? r.tables.length : 0,
      }));
      console.log(renderTable(tableRows));
    }
  });

  kb.command('related').requiredOption('--service <service>').action((opts) => {
    const ctx = getCtx();
    const s = String(opts.service).toLowerCase();
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
}
