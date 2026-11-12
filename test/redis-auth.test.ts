import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { redisPlugin } from '../src/plugins-builtins/redis/index.js';
import { DoctorStatus } from '../src/types/core.js';
import { testDatasource } from './helpers/datasource.js';
import { stubRedisCli } from './helpers/redis-cli-stub.js';

describe('redis auth', () => {
  it('passes the password through REDISCLI_AUTH, never through argv', async () => {
    // arrange
    const binDir = stubRedisCli(
      `printf '%s\\n' "$@" > "$(dirname "$0")/args.txt"\nprintf '%s' "$REDISCLI_AUTH" > "$(dirname "$0")/auth.txt"\necho PONG\n`,
    );
    const credentials = { user: 'reader', password: 's3cret-profile-pass' };

    // act
    const checks = await redisPlugin.doctor!({ datasource: testDatasource('redis', 6379, {}), credentials });

    // assert
    const args = fs.readFileSync(path.join(binDir, 'args.txt'), 'utf8').split('\n');
    expect(checks[0]?.status).toBe(DoctorStatus.Ok);
    expect(args.some((a) => a.includes(credentials.password))).toBe(false);
    expect(args).not.toContain('-a');
    expect(args).toEqual(expect.arrayContaining(['--user', 'reader']));
    expect(fs.readFileSync(path.join(binDir, 'auth.txt'), 'utf8')).toBe(credentials.password);
  });
});
