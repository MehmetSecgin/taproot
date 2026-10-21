import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { rpcCall } from '../src/daemon/client.js';
import { startDaemon } from '../src/daemon/server.js';
import type { RpcResponse } from '../src/daemon/types.js';

function rawRpc(socketPath: string, clientVersion: string): Promise<RpcResponse> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ protocolVersion: 1, clientVersion, requestId: 'old-cli', method: 'daemon.status', params: {} })}\n`);
    });
    socket.on('data', (chunk) => {
      buffer += chunk;
      const idx = buffer.indexOf('\n');
      if (idx >= 0) {
        socket.end();
        resolve(JSON.parse(buffer.slice(0, idx)) as RpcResponse);
      }
    });
  });
}

async function waitForDaemon(socketPath: string): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    const ok = await rpcCall({ socketPath, method: 'daemon.status' }).then((res) => res.ok, () => false);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('daemon did not start');
}

describe('daemon version handoff', () => {
  it('stops a daemon of another version and leaves the socket to its successor', async () => {
    // arrange
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-'));
    const socketPath = path.join(stateRoot, 'run', 'taprootd.sock');
    const pidFile = path.join(stateRoot, 'run', 'taprootd.pid');
    const old = spawn(process.execPath, [path.join(process.cwd(), 'dist', 'daemon-main.js')], {
      env: { ...process.env, TAPROOT_STATE_ROOT: stateRoot },
      stdio: 'ignore',
    });
    const oldExited = new Promise((resolve) => old.once('exit', resolve));
    await waitForDaemon(socketPath);

    // act
    const res = await rawRpc(socketPath, '0.0.0-other');
    const socketLeftAfterMismatch = fs.existsSync(socketPath);
    const successor = await startDaemon({ stateRoot, socketPath });
    await oldExited;

    // assert
    try {
      expect(res.error?.code).toBe('DAEMON_VERSION_MISMATCH');
      expect(socketLeftAfterMismatch).toBe(false);
      expect(fs.readFileSync(pidFile, 'utf8').trim()).toBe(String(process.pid));
      const status = await rpcCall({ socketPath, method: 'daemon.status' });
      expect(status.ok).toBe(true);
    } finally {
      await successor.stop();
    }
  });
});
