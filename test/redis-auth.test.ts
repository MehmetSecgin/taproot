import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { redisPlugin } from '../src/plugins-builtins/redis/index.js';
import { DoctorStatus, type DatasourceProfile } from '../src/types/core.js';

const originalPath = process.env.PATH;

function stubRedisCli(): { binDir: string; argsFile: string; authFile: string } {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-redis-cli-stub-'));
  const argsFile = path.join(binDir, 'args.txt');
  const authFile = path.join(binDir, 'auth.txt');
  const script = path.join(binDir, 'redis-cli');
  fs.writeFileSync(
    script,
    `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\nprintf '%s' "$REDISCLI_AUTH" > '${authFile}'\necho PONG\n`,
  );
  fs.chmodSync(script, 0o755);
  return { binDir, argsFile, authFile };
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

describe('redis auth', () => {
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it('passes the password through REDISCLI_AUTH, never through argv', async () => {
    // arrange
    const stub = stubRedisCli();
    process.env.PATH = `${stub.binDir}:/usr/bin:/bin`;
    const credentials = { user: 'reader', password: 's3cret-profile-pass' };

    // act
    const checks = await redisPlugin.doctor!({ datasource: cacheDatasource(), credentials });

    // assert
    const args = fs.readFileSync(stub.argsFile, 'utf8').split('\n');
    expect(checks[0]?.status).toBe(DoctorStatus.Ok);
    expect(args.some((a) => a.includes(credentials.password))).toBe(false);
    expect(args).not.toContain('-a');
    expect(args).toEqual(expect.arrayContaining(['--user', 'reader']));
    expect(fs.readFileSync(stub.authFile, 'utf8')).toBe(credentials.password);
  });
});
