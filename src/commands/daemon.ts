import { Command } from 'commander';
import { printJson } from '../core/output.js';
import { rpcCall } from '../daemon/client.js';
import { RpcMethod } from '../daemon/types.js';

export function registerDaemon(program: Command): void {
  const d = program.command('daemon').description('The background daemon that keeps tunnels and connection pools open; the first query starts it');

  d.command('status').description('Show the running daemon: version, pid, sessions and query limits').action(async () => {
    const res = await rpcCall({ method: RpcMethod.DaemonStatus });
    if (!res.ok) throw new Error(res.error?.message || 'daemon status failed');
    printJson({ ok: true, data: res.data || {}, meta: { ...(res.meta || {}), requestId: res.requestId } });
  });

  d.command('stop').description('Stop the daemon; the next query starts a fresh one').action(async () => {
    const res = await rpcCall({ method: RpcMethod.DaemonStop }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' || error.code === 'ECONNREFUSED') return null;
      throw error;
    });
    if (!res) return printJson({ ok: true, data: { running: false } });
    if (!res.ok) throw new Error(res.error?.message || 'daemon stop failed');
    printJson({ ok: true, data: res.data || {}, meta: { ...(res.meta || {}), requestId: res.requestId } });
  });
}
