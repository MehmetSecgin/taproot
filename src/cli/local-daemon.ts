import { str } from '../core/strings.js';
import { rpcCall } from '../daemon/client.js';
import { spawnDaemon } from '../daemon/spawn.js';
import { DAEMON_VERSION_MISMATCH } from '../daemon/types.js';
import type { RpcResponse } from '../daemon/types.js';

export async function callLocalDaemon(
  request: { method: string; params: Record<string, unknown>; timeoutMs: number },
  logVerbose: (msg: string) => void,
): Promise<RpcResponse | undefined> {
  const callDaemon = async (): Promise<RpcResponse | undefined> => {
    try {
      const res = await rpcCall(request);
      if (res.error?.code !== DAEMON_VERSION_MISMATCH) return res;
      logVerbose(res.error.message);
      return undefined;
    } catch (error) {
      const msg = str((error as Error).message);
      if (!/(ENOENT|ECONNREFUSED|EINVAL|ENAMETOOLONG|EPIPE|socket hang up)/i.test(msg)) {
        throw error;
      }
      logVerbose(`daemon RPC unavailable (${msg})`);
      return undefined;
    }
  };
  let rpc = await callDaemon();
  if (!rpc) {
    logVerbose('starting taprootd');
    if (await spawnDaemon()) rpc = await callDaemon();
  }
  if (!rpc) logVerbose('daemon unavailable, falling back to direct mode');
  return rpc;
}
