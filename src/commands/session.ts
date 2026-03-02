import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { printJson, renderTable } from '../core/output.js';
import { rpcCall } from '../daemon/client.js';

export function registerSession(program: Command, getCtx: () => AppContext): void {
  const s = program.command('session').description('Session operations via telequeryd');

  s.command('open')
    .requiredOption('--datasource <name>')
    .option('--env <env>')
    .option('--service <service>')
    .option('--kind <kind>')
    .action(async (opts) => {
      const ctx = getCtx();
      const res = await rpcCall({
        method: 'session.open',
        params: {
          datasource: opts.datasource,
          env: opts.env,
          service: opts.service,
          kind: opts.kind,
        },
      });
      if (!res.ok) throw new Error(res.error?.message || 'session.open failed');
      printJson(res.data || {});
    });

  s.command('ls').action(async () => {
    const ctx = getCtx();
    const res = await rpcCall({ method: 'session.list' });
    if (!res.ok) throw new Error(res.error?.message || 'session.list failed');
    const rows = ((res.data?.sessions as Array<Record<string, unknown>>) || []).map((v) => ({
      sessionId: String(v.sessionId || ''),
      datasource: String(v.datasourceName || ''),
      state: String(v.state || ''),
      leases: Number(v.leaseCount || 0),
      lastUsedAt: String(v.lastUsedAt || ''),
    }));
    if (ctx.jsonMode) printJson({ sessions: rows });
    else console.log(renderTable(rows));
  });

  s.command('inspect')
    .requiredOption('--session-id <id>')
    .action(async (opts) => {
      const res = await rpcCall({ method: 'session.inspect', params: { sessionId: opts.sessionId } });
      if (!res.ok) throw new Error(res.error?.message || 'session.inspect failed');
      printJson(res.data || {});
    });

  s.command('close')
    .requiredOption('--session-id <id>')
    .action(async (opts) => {
      const ctx = getCtx();
      const res = await rpcCall({ method: 'session.close', params: { sessionId: opts.sessionId } });
      if (!res.ok) throw new Error(res.error?.message || 'session.close failed');
      if (ctx.jsonMode) printJson(res.data || {});
      else console.log(`closed ${opts.sessionId}`);
    });

  s.command('close-all').action(async () => {
    const ctx = getCtx();
    const res = await rpcCall({ method: 'session.closeAll' });
    if (!res.ok) throw new Error(res.error?.message || 'session.closeAll failed');
    if (ctx.jsonMode) printJson(res.data || {});
    else console.log(`closed ${(res.data?.closedCount as number) || 0} sessions`);
  });
}
