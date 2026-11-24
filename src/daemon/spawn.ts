import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rpcCall } from './client.js';
import { defaultSocketPath } from './socket-path.js';
import { RpcMethod } from './types.js';
import type { RpcResponse } from './types.js';
import { waitMs } from '../core/wait.js';

const DAEMON_STARTUP_WAIT_MS = 5000;
const DAEMON_STATUS_POLL_MS = 50;

function resolveDaemonEntry(): string {
  const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(currentDirectory, 'daemon-main.js'),
    path.join(currentDirectory, '..', 'daemon-main.js'),
    path.join(currentDirectory, '..', '..', 'dist', 'daemon-main.js'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}

function daemonLogPath(): string {
  return path.join(path.dirname(defaultSocketPath()), 'taprootd.log');
}

async function readDaemonStatusIfUp(): Promise<RpcResponse | undefined> {
  try {
    const reply = await rpcCall({ method: RpcMethod.DaemonStatus });
    return reply.ok ? reply : undefined;
  } catch {
    return undefined;
  }
}

async function waitForDaemonStatus(): Promise<RpcResponse | undefined> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < DAEMON_STARTUP_WAIT_MS) {
    const status = await readDaemonStatusIfUp();
    if (status !== undefined) {
      return status;
    }
    await waitMs(DAEMON_STATUS_POLL_MS);
  }
  return undefined;
}

export async function spawnDaemon(): Promise<RpcResponse | undefined> {
  const logPath = daemonLogPath();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const child = spawn(process.execPath, [resolveDaemonEntry()], {
    detached: true,
    stdio: ['ignore', fs.openSync(logPath, 'a'), fs.openSync(logPath, 'a')],
  });
  child.unref();
  return waitForDaemonStatus();
}
