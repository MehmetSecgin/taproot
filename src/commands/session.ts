import { Command } from 'commander';
import { printJson } from '../core/output.js';
import { rpcCall } from '../daemon/client.js';
import { RpcMethod } from '../daemon/types.js';
import { str } from '../core/strings.js';

export function registerSession(program: Command): void {
  const s = program.command('session').description('Session operations via taprootd');

  s.command('open')
    .requiredOption('--datasource <name>')
    .option('--env <env>')
    .option('--service <service>')
    .option('--kind <kind>')
    .action(async (opts) => {
      const res = await rpcCall({
        method: RpcMethod.SessionOpen,
        params: {
          datasource: opts.datasource,
          env: opts.env,
          service: opts.service,
          kind: opts.kind,
        },
      });
      if (!res.ok) throw new Error(res.error?.message || 'session.open failed');
      printJson({
        ok: true,
        data: res.data || {},
        meta: { ...(res.meta || {}), requestId: res.requestId },
      });
    });

  s.command('ls').action(async () => {
    const res = await rpcCall({ method: RpcMethod.SessionList });
    if (!res.ok) throw new Error(res.error?.message || 'session.list failed');
    const rows = ((res.data?.sessions as Array<Record<string, unknown>>) || []).map((v) => ({
      sessionId: str(v.sessionId),
      datasource: str(v.datasourceName),
      state: str(v.state),
      leases: Number(v.leaseCount || 0),
      lastUsedAt: str(v.lastUsedAt),
    }));
    printJson({
      ok: true,
      data: { sessions: rows },
      meta: { ...(res.meta || {}), requestId: res.requestId },
    });
  });

  s.command('inspect')
    .requiredOption('--session-id <id>')
    .action(async (opts) => {
      const res = await rpcCall({ method: RpcMethod.SessionInspect, params: { sessionId: opts.sessionId } });
      if (!res.ok) throw new Error(res.error?.message || 'session.inspect failed');
      printJson({
        ok: true,
        data: res.data || {},
        meta: { ...(res.meta || {}), requestId: res.requestId },
      });
    });

  s.command('close')
    .requiredOption('--session-id <id>')
    .action(async (opts) => {
      const res = await rpcCall({ method: RpcMethod.SessionClose, params: { sessionId: opts.sessionId } });
      if (!res.ok) throw new Error(res.error?.message || 'session.close failed');
      printJson({
        ok: true,
        data: res.data || {},
        meta: { ...(res.meta || {}), requestId: res.requestId },
      });
    });

  s.command('close-all').action(async () => {
    const res = await rpcCall({ method: RpcMethod.SessionCloseAll });
    if (!res.ok) throw new Error(res.error?.message || 'session.closeAll failed');
    printJson({
      ok: true,
      data: res.data || {},
      meta: { ...(res.meta || {}), requestId: res.requestId },
    });
  });
}
