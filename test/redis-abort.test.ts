import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { redisPlugin } from '../src/plugins-builtins/redis/index.js';
import { testDatasource } from './helpers/datasource.js';
import { stubRedisCli } from './helpers/redis-cli-stub.js';
import { executeOf } from './helpers/mysql-row-cap-support.js';

function processStateOf(pid: number): 'running' | 'exited' {
  try {
    process.kill(pid, 0);
    return 'running';
  } catch {
    return 'exited';
  }
}

describe('redis abort', () => {
  it('kills redis-cli and fails with the abort reason when the caller aborts', async () => {
    // arrange
    const binDir = stubRedisCli('echo $$ > "$(dirname "$0")/pid.txt"\nexec sleep 30\n');
    const pidFile = path.join(binDir, 'pid.txt');
    const caller = new AbortController();
    const pending = executeOf(redisPlugin)(
      {
        datasource: testDatasource('redis', 6379, {}),
        query: 'GET profile:1',
        capability: 'executeRead',
        timeoutMs: 30_000,
        sessionTimeZone: '+00:00',
        signal: caller.signal,
      },
      { user: 'reader', password: 'x' },
    );
    await vi.waitFor(() => {
      expect(fs.readdirSync(binDir)).toContain('pid.txt');
    });
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));

    // act
    caller.abort(new Error('client disconnected'));

    // assert
    await expect(pending).rejects.toThrow('client disconnected');
    await vi.waitFor(() => {
      expect(processStateOf(pid)).toBe('exited');
    });
  });
});
