import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { redisPlugin } from '../src/plugins-builtins/redis/index.js';
import type { DatasourceProfile } from '../src/types/core.js';

const originalPath = process.env.PATH;

function stubHangingRedisCli(): { binDir: string; pidFile: string } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-redis-cli-hang-'));
  const pidFile = path.join(binDir, 'pid.txt');
  const script = path.join(binDir, 'redis-cli');
  fs.writeFileSync(script, `#!/bin/sh\necho $$ > '${pidFile}'\nexec sleep 30\n`);
  fs.chmodSync(script, 0o755);
  return { binDir, pidFile };
}

function cacheDatasource(): DatasourceProfile {
  return {
    name: 'qa-profile-cache',
    kind: 'redis',
    connection: { host: '127.0.0.1', port: 6379 },
    credentialRef: 'qa:profile-cache',
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    updatedAt: new Date().toISOString(),
    confidence: 0.9,
  };
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('redis abort', () => {
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it('kills redis-cli and fails with the abort reason when the caller aborts', async () => {
    // arrange
    const stub = stubHangingRedisCli();
    process.env.PATH = `${stub.binDir}:/usr/bin:/bin`;
    const caller = new AbortController();
    const pending = redisPlugin.execute!(
      {
        datasource: cacheDatasource(),
        query: 'GET profile:1',
        capability: 'executeRead',
        timeoutMs: 30_000,
        sessionTimeZone: '+00:00',
        signal: caller.signal,
      },
      { user: 'reader', password: 'x' },
    );
    await vi.waitFor(() => expect(fs.existsSync(stub.pidFile)).toBe(true));
    const pid = Number(fs.readFileSync(stub.pidFile, 'utf8'));

    // act
    caller.abort(new Error('client disconnected'));

    // assert
    await expect(pending).rejects.toThrow('client disconnected');
    await vi.waitFor(() => expect(isRunning(pid)).toBe(false));
  });
});
