import type { CliCommand, LocalExecutor } from '../cli/types.js';
import { printJson } from '../core/output.js';
import { rpcCall } from '../daemon/client.js';
import { RpcMethod } from '../daemon/types.js';
import type { RpcResponse } from '../daemon/types.js';
import { nonEmptyOr } from '../core/text-presence.js';

function isDaemonNotRunning(error: unknown): boolean {
  const code: unknown = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined;
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

async function stopRunningDaemon(): Promise<RpcResponse | undefined> {
  try {
    return await rpcCall({ method: RpcMethod.DaemonStop });
  } catch (error) {
    if (isDaemonNotRunning(error)) {
      return undefined;
    }
    throw error;
  }
}

function printDaemonReply(reply: RpcResponse, failureMessage: string): void {
  if (!reply.ok) {
    throw new Error(nonEmptyOr(reply.error?.message, failureMessage));
  }
  printJson({ ok: true, data: reply.data ?? {}, meta: { ...reply.meta, requestId: reply.requestId } });
}

export const daemonCommand: CliCommand<LocalExecutor> = (program) => {
  const daemon = program.command('daemon').description('The background daemon that keeps tunnels and connection pools open; the first query starts it');

  daemon.command('status').description('Show the running daemon: version, pid, sessions and query limits').action(async () => {
    printDaemonReply(await rpcCall({ method: RpcMethod.DaemonStatus }), 'daemon status failed');
  });

  daemon.command('stop').description('Stop the daemon; the next query starts a fresh one').action(async () => {
    const reply = await stopRunningDaemon();
    if (reply === undefined) {
      printJson({ ok: true, data: { running: false } });
      return;
    }
    printDaemonReply(reply, 'daemon stop failed');
  });
};
