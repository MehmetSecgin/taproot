import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { redisPlugin } from '../src/plugins-builtins/redis/index.js';
import type { DatasourceProfile, QueryRequest } from '../src/types/core.js';

const originalPath = process.env.PATH;

function stubRedisCli(rawReply: string, quotedReply: string): string {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-redis-cli-'));
  const script = path.join(binDir, 'redis-cli');
  fs.writeFileSync(
    script,
    `#!/bin/sh\nfor arg in "$@"; do\n  if [ "$arg" = "--no-raw" ]; then printf '%s' '${quotedReply}'; exit 0; fi\ndone\nprintf '%s' '${rawReply}'\n`,
  );
  fs.chmodSync(script, 0o755);
  return binDir;
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

function profileCache(resolverHints: Record<string, string> = {}): DatasourceProfile {
  return {
    name: 'unit-profile-cache',
    kind: 'redis',
    connection: { host: '127.0.0.1', port: 6379 },
    credentialRef: 'unit:profile-cache',
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    resolverHints,
    updatedAt: new Date().toISOString(),
    confidence: 0.9,
  };
}

function read(datasource: DatasourceProfile, query: string): QueryRequest {
  return { datasource, query, capability: 'executeRead', timeoutMs: 5000, sessionTimeZone: '+00:00', signal: undefined };
}

describe('redis commands', () => {
  afterEach(() => {
    process.env.PATH = originalPath;
  });

  it('lists key names as text when the datasource has a protoMessage hint', async () => {
    // arrange
    process.env.PATH = `${stubRedisCli('user:1\nhi\n', '1) "user:1"\n2) "hi"\n')}:/usr/bin:/bin`;
    const datasource = profileCache({ protoRoot: protoRoot(), protoMessage: 'taproot.test.Profile' });

    // act
    const result = await redisPlugin.execute!(read(datasource, 'KEYS *'), {});

    // assert
    expect(result.result.rows).toEqual([['user:1'], ['hi']]);
  });

  it('runs SORT_RO as a read', async () => {
    // arrange
    process.env.PATH = `${stubRedisCli('3\n7\n', '1) "3"\n2) "7"\n')}:/usr/bin:/bin`;

    // act
    const result = await redisPlugin.execute!(read(profileCache(), 'SORT_RO profile:ids'), {});

    // assert
    expect(result.result.rows).toEqual([['3'], ['7']]);
  });
});
