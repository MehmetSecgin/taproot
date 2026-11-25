import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { SCAN_COUNT_MAX } from '../src/plugins-builtins/redis/command-policy.js';
import { redisPlugin } from '../src/plugins-builtins/redis/index.js';
import type { DatasourceProfile } from '../src/types/datasource.js';
import type { QueryRequest } from '../src/types/plugin.js';
import { testDatasource } from './helpers/datasource.js';
import { stubRedisCli } from './helpers/redis-cli-stub.js';

function replyWith(rawReply: string, quotedReply: string): void {
  stubRedisCli(
    `for arg in "$@"; do\n  if [ "$arg" = "--no-raw" ]; then printf '%s' '${quotedReply}'; exit 0; fi\ndone\nprintf '%s' '${rawReply}'\n`,
  );
}

function protoRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-redis-proto-'));
  fs.writeFileSync(
    path.join(dir, 'profile.proto'),
    'syntax = "proto3";\npackage taproot.test;\n\nmessage Profile {\n  string name = 1;\n}\n',
    'utf8',
  );
  return dir;
}

function read(datasource: DatasourceProfile, query: string, pluginParams?: QueryRequest['pluginParams']): QueryRequest {
  return { datasource, query, capability: 'executeRead', timeoutMs: 5000, sessionTimeZone: '+00:00', signal: undefined, pluginParams };
}

async function executeRedis(request: QueryRequest, credentials: Record<string, string>): ReturnType<NonNullable<typeof redisPlugin.execute>> {
  const { execute } = redisPlugin;
  if (execute === undefined) {
    throw new Error('redis plugin has no execute');
  }
  return execute.call(redisPlugin, request, credentials);
}

function strict(): DatasourceProfile {
  const datasource = testDatasource('redis', 6379, {});
  datasource.policy.strictKeyspace = true;
  return datasource;
}

describe('redis commands', () => {
  it('lists key names as text when the datasource has a protoMessage hint', async () => {
    // arrange
    replyWith('user:1\nhi\n', '1) "user:1"\n2) "hi"\n');
    const datasource = testDatasource('redis', 6379, { protoRoot: protoRoot(), protoMessage: 'taproot.test.Profile' });

    // act
    const result = await executeRedis(read(datasource, 'KEYS *'), {});

    // assert
    expect(result.result.rows).toStrictEqual([['user:1'], ['hi']]);
  });

  it('runs SORT_RO as a read', async () => {
    // arrange
    replyWith('3\n7\n', '1) "3"\n2) "7"\n');

    // act
    const result = await executeRedis(read(testDatasource('redis', 6379, {}), 'SORT_RO profile:ids'), {});

    // assert
    expect(result.result.rows).toStrictEqual([['3'], ['7']]);
  });

  it('refuses KEYS without --allow-keys on a strict-keyspace datasource', async () => {
    // arrange
    replyWith('user:1\n', '1) "user:1"\n');

    // act
    const run = executeRedis(read(strict(), 'keys *'), {});

    // assert
    await expect(run).rejects.toThrow(/--allow-keys/u);
  });

  it('refuses SCAN without COUNT', async () => {
    // arrange
    replyWith('0\n', '1) "0"\n');

    // act
    const run = executeRedis(read(strict(), 'SCAN 0 MATCH user:*'), {});

    // assert
    await expect(run).rejects.toThrow(/explicit COUNT/u);
  });

  it('refuses SCAN with COUNT above the cap', async () => {
    // arrange
    replyWith('0\n', '1) "0"\n');

    // act
    const run = executeRedis(read(strict(), `SCAN 0 COUNT ${SCAN_COUNT_MAX + 1}`), {});

    // assert
    await expect(run).rejects.toThrow(/COUNT must be an integer/u);
  });

  it('refuses a query when requireDatabase is set and the database is missing', async () => {
    // arrange
    replyWith('v\n', '"v"\n');
    const datasource = testDatasource('redis', 6379, {});
    datasource.policy.requireDatabase = true;

    // act
    const run = executeRedis(read(datasource, 'GET user:1'), {});

    // assert
    await expect(run).rejects.toThrow(/MISCONFIGURED_DATASOURCE/u);
  });

  it('runs a query when requireDatabase is set and the database is given', async () => {
    // arrange
    replyWith('v\n', '"v"\n');
    const datasource = testDatasource('redis', 6379, {});
    datasource.policy.requireDatabase = true;
    datasource.connection.database = '3';

    // act
    const result = await executeRedis(read(datasource, 'GET user:1'), {});

    // assert
    expect(result.result.rows).toStrictEqual([['v']]);
  });

  it('runs KEYS on a strict-keyspace datasource with --allow-keys', async () => {
    // arrange
    replyWith('user:1\n', '1) "user:1"\n');

    // act
    const result = await executeRedis(read(strict(), 'KEYS *', { allowKeys: true }), {});

    // assert
    expect(result.result.rows).toStrictEqual([['user:1']]);
  });

  it('runs SCAN without COUNT on a default datasource', async () => {
    // arrange
    replyWith('0\n', '1) "0"\n');

    // act
    const result = await executeRedis(read(testDatasource('redis', 6379, {}), 'SCAN 0'), {});

    // assert
    expect(result.result.rows).toStrictEqual([['0']]);
  });

  it('checks the last COUNT, as Redis does', async () => {
    // arrange
    replyWith('0\n', '1) "0"\n');

    // act
    const run = executeRedis(read(strict(), `SCAN 0 COUNT 10 COUNT ${SCAN_COUNT_MAX + 1}`), {});

    // assert
    await expect(run).rejects.toThrow(/COUNT must be an integer/u);
  });

  it('accepts a MATCH pattern that is literally COUNT', async () => {
    // arrange
    replyWith('0\n', '1) "0"\n');

    // act
    const result = await executeRedis(read(strict(), 'SCAN 0 MATCH COUNT COUNT 10'), {});

    // assert
    expect(result.result.rows).toStrictEqual([['0']]);
  });
});
