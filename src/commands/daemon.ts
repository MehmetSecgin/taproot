import { Command } from 'commander';
import { printJson } from '../core/output.js';
import { rpcCall } from '../daemon/client.js';
import { daemonLogPath, spawnDaemon } from '../daemon/spawn.js';
import { RpcMethod } from '../daemon/types.js';

async function startOrThrow(): Promise<unknown> {
  const res = await spawnDaemon();
  if (!res) throw new Error(`taprootd did not become healthy within timeout. Check ${daemonLogPath()}`);
  return res.data;
}

export function registerDaemon(program: Command): void {
  const d = program.command('daemon').description('taproot daemon operations');

  d.command('start').action(async () => {
    printJson({ started: true, status: await startOrThrow() });
  });

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

  d.command('restart').action(async () => {
    try {
      await rpcCall({ method: RpcMethod.DaemonStop });
    } catch {
      // ignore if not running
    }
    printJson({ restarted: true, status: await startOrThrow() });
  });
}
