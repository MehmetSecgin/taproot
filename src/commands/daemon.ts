import { Command } from 'commander';
import { printJson } from '../core/output.js';
import { rpcCall } from '../daemon/client.js';
import { RpcMethod } from '../daemon/types.js';

export function registerDaemon(program: Command): void {
  const d = program.command('daemon').description('taproot daemon operations');

  d.command('status').action(async () => {
    const res = await rpcCall({ method: RpcMethod.DaemonStatus });
    if (!res.ok) throw new Error(res.error?.message || 'daemon status failed');
    printJson({ ok: true, data: res.data || {}, meta: { ...(res.meta || {}), requestId: res.requestId } });
  });

  d.command('stop').action(async () => {
    const res = await rpcCall({ method: RpcMethod.DaemonStop });
    if (!res.ok) throw new Error(res.error?.message || 'daemon stop failed');
    printJson({ ok: true, data: res.data || {}, meta: { ...(res.meta || {}), requestId: res.requestId } });
  });
}
