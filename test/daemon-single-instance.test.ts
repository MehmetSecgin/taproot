import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { rpcCall } from '../src/daemon/client.js';
import { startDaemon } from '../src/daemon/server.js';

describe('daemon single instance', () => {
  it('refuses to start a second daemon on a live socket and keeps the first one serving', async () => {
    // arrange
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-'));
    const socketPath = path.join(stateRoot, 'run', 'taprootd-test.sock');
    const first = await startDaemon({ stateRoot, socketPath });
    try {
      // act
      const second = startDaemon({ stateRoot, socketPath });

      // assert
      await expect(second).rejects.toThrow('taprootd already running');
      const status = await rpcCall({ socketPath, method: 'daemon.status' });
      expect(status.ok).toBe(true);
    } finally {
      await first.stop();
    }
  });

  it('replaces a stale socket file left by a dead daemon', async () => {
    // arrange
    const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'trd-'));
    const socketPath = path.join(stateRoot, 'run', 'taprootd-test.sock');
    fs.mkdirSync(path.dirname(socketPath), { recursive: true });
    fs.writeFileSync(socketPath, '');

    // act
    const daemon = await startDaemon({ stateRoot, socketPath });
    try {
      // assert
      const status = await rpcCall({ socketPath, method: 'daemon.status' });
      expect(status.ok).toBe(true);
    } finally {
      await daemon.stop();
    }
  });
});
