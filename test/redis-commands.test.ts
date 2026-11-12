import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { redisPlugin } from '../src/plugins-builtins/redis/index.js';
import type { DatasourceProfile, QueryRequest } from '../src/types/core.js';
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

function read(datasource: DatasourceProfile, query: string): QueryRequest {
  return { datasource, query, capability: 'executeRead', timeoutMs: 5000, sessionTimeZone: '+00:00', signal: undefined };
}

describe('redis commands', () => {
  it('lists key names as text when the datasource has a protoMessage hint', async () => {
    // arrange
    replyWith('user:1\nhi\n', '1) "user:1"\n2) "hi"\n');
    const datasource = testDatasource('redis', 6379, { protoRoot: protoRoot(), protoMessage: 'taproot.test.Profile' });

    // act
    const result = await redisPlugin.execute!(read(datasource, 'KEYS *'), {});

    // assert
    expect(result.result.rows).toEqual([['user:1'], ['hi']]);
  });

  it('runs SORT_RO as a read', async () => {
    // arrange
    replyWith('3\n7\n', '1) "3"\n2) "7"\n');

    // act
    const result = await redisPlugin.execute!(read(testDatasource('redis', 6379, {}), 'SORT_RO profile:ids'), {});

    // assert
    expect(result.result.rows).toEqual([['3'], ['7']]);
  });
});
