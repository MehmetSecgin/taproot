import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { printJson } from '../core/output.js';

export function registerKb(program: Command, getCtx: () => AppContext): void {
  const kb = program.command('kb').description('Knowledge base resolvers');

  kb.command('resolve-connection').requiredOption('--service <service>').requiredOption('--env <env>').action((opts) => {
    const ctx = getCtx();
    const out = ctx.kbStore.resolveConnection(opts.service, opts.env);
    if (!out) throw new Error('No KB connection match.');
    printJson(out);
  });

  kb.command('resolve-credentials').requiredOption('--service <service>').requiredOption('--env <env>').action((opts) => {
    const ctx = getCtx();
    const out = ctx.kbStore.resolveConnection(opts.service, opts.env);
    if (!out) throw new Error('No KB credentials match.');
    printJson({
      service: opts.service,
      env: opts.env,
      target: out.target,
      database: out.database,
      db_user: out.db_user,
      engine: out.engine,
      access_method: out.access_method,
      verified_at_utc: out.verified_at_utc,
    });
  });

  kb.command('resolve-database-name').requiredOption('--service <service>').requiredOption('--env <env>').action((opts) => {
    const ctx = getCtx();
    const out = ctx.kbStore.resolveConnection(opts.service, opts.env);
    if (!out) throw new Error('No KB database match.');
    printJson({ service: opts.service, env: opts.env, database: out.database, verified_at_utc: out.verified_at_utc });
  });

  kb.command('resolve-query').requiredOption('--service <service>').requiredOption('--intent <intent>').action((opts) => {
    const ctx = getCtx();
    const out = ctx.kbStore.resolveQuery(opts.service, opts.intent);
    if (!out) throw new Error('No KB query template match.');
    printJson(out);
  });

  kb.command('tables').requiredOption('--service <service>').option('--env <env>').option('--text <text>').action((opts) => {
    const ctx = getCtx();
    const rows = ctx.kbStore.tables().filter((r) => String(r.service || '').toLowerCase() === String(opts.service).toLowerCase());
    const scoped = rows.filter((r) => !opts.env || String(r.env) === String(opts.env));
    const filtered = scoped.map((r) => ({ ...r, tables: opts.text ? (r.tables || []).filter((t: string) => t.toLowerCase().includes(String(opts.text).toLowerCase())) : r.tables }));
    printJson(filtered);
  });

  kb.command('related').requiredOption('--service <service>').action((opts) => {
    const ctx = getCtx();
    const s = String(opts.service).toLowerCase();
    const rows = ctx.kbStore.relations().filter((r) => String(r?.from?.service || '').toLowerCase() === s || String(r?.to?.service || '').toLowerCase() === s);
    printJson(rows);
  });
}
