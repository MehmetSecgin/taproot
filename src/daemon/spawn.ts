import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultSocketPath, rpcCall } from './client.js';
import { RpcMethod, type RpcResponse } from './types.js';

function resolveDaemonEntry(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, 'daemon-main.js'),
    path.join(here, '..', 'daemon-main.js'),
    path.join(here, '..', '..', 'dist', 'daemon-main.js'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

function daemonLogPath(): string {
  return path.join(path.dirname(defaultSocketPath()), 'taprootd.log');
}

export async function spawnDaemon(): Promise<RpcResponse | undefined> {
  const logPath = daemonLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const child = spawn(process.execPath, [resolveDaemonEntry()], {
    detached: true,
    stdio: ['ignore', fs.openSync(logPath, 'a'), fs.openSync(logPath, 'a')],
  });
  child.unref();

  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    try {
      const res = await rpcCall({ method: RpcMethod.DaemonStatus });
      if (res.ok) return res;
    } catch {
      // wait for daemon
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}
