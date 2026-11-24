import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { rpcCall } from '../src/daemon/client.js';
import { startLocalDaemon } from './helpers/daemon.js';
import type { RpcResponse } from '../src/daemon/types.js';
import { tempStateRoot } from './helpers/state-root.js';
import { waitMs } from '../src/core/wait.js';

function isRpcResponse(value: unknown): value is RpcResponse {
  return typeof value === 'object' && value !== null;
}

async function rawRpc(socketPath: string, clientVersion: string): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ protocolVersion: 1, clientVersion, requestId: 'old-cli', method: 'daemon.status', params: {} })}\n`);
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf('\n');
      if (newlineIndex === -1) {
        return;
      }
      socket.end();
      const reply: unknown = JSON.parse(buffer.slice(0, newlineIndex));
      if (isRpcResponse(reply)) {
        resolve(reply);
      } else {
        reject(new Error('daemon reply was not a JSON object'));
      }
    });
  });
}

async function isDaemonUp(socketPath: string): Promise<boolean> {
  try {
    const reply = await rpcCall({ socketPath, method: 'daemon.status' });
    return reply.ok;
  } catch {
    return false;
  }
}

async function waitForDaemon(socketPath: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (await isDaemonUp(socketPath)) {
      return;
    }
    await waitMs(50);
  }
  throw new Error('daemon did not start');
}

describe('daemon version handoff', () => {
  it('stops a daemon of another version and leaves the socket to its successor', async () => {
    // arrange
    const { stateRoot } = tempStateRoot();
    const socketPath = path.join(stateRoot, 'run', 'taprootd.sock');
    const old = spawn(process.execPath, [path.join(process.cwd(), 'dist', 'daemon-main.js')], {
      env: { ...process.env, TAPROOT_STATE_ROOT: stateRoot },
      stdio: 'ignore',
    });
    const oldExited = new Promise<void>((resolve) => {
      old.once('exit', () => {
        resolve();
      });
    });
    await waitForDaemon(socketPath);

    // act
    const res = await rawRpc(socketPath, '0.0.0-other');
    const socketLeftAfterMismatch = fs.existsSync(socketPath);
    const successor = await startLocalDaemon({ stateRoot, socketPath, plugins: [] });
    await oldExited;

    // assert
    try {
      expect(res.error?.code).toBe('DAEMON_VERSION_MISMATCH');
      expect(socketLeftAfterMismatch).toBe(false);
      const status = await rpcCall({ socketPath, method: 'daemon.status' });
      expect(status.ok).toBe(true);
      expect(status.data?.pid).toBe(process.pid);
    } finally {
      await successor.stop();
    }
  });
});
