import fs from 'node:fs';
import path from 'node:path';
import { rpcCall } from './client.js';
import { DAEMON_VERSION_MISMATCH, RpcMethod } from './types.js';

async function isDaemonAlive(socketPath: string): Promise<boolean> {
  try {
    const reply = await rpcCall({ socketPath, method: RpcMethod.DaemonStatus });
    return reply.error?.code !== DAEMON_VERSION_MISMATCH;
  } catch {
    return false;
  }
}

export async function claimSocket(socketPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(socketPath), { recursive: true });
  if (!fs.existsSync(socketPath)) {
    return;
  }
  if (await isDaemonAlive(socketPath)) {
    throw new Error(`taprootd already running on ${socketPath}`);
  }
  fs.rmSync(socketPath, { force: true });
}
