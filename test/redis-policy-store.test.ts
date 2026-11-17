import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DatasourceStore } from '../src/store/datasources.js';
import type { DatasourceProfile } from '../src/types/core.js';
import { redisPlugin } from '../src/plugins-builtins/redis/index.js';
import { testDatasource } from './helpers/datasource.js';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';
import { stubRedisCli } from './helpers/redis-cli-stub.js';

function profileWith(redisCommands: string[]): DatasourceProfile {
  const datasource = testDatasource('redis', 6379, {});
  datasource.policy.redisCommands = redisCommands;
  return datasource;
}

describe('policy.redisCommands is kept by the datasource store', () => {
  it('keeps the allowlist when a profile is saved and loaded again', () => {
    // arrange
    const { configDir } = tempStateRoot();
    const file = path.join(configDir, 'datasources.json');
    new DatasourceStore(file).save(profileWith(['GET', 'TTL']));

    // act
    const loaded = new DatasourceStore(file).get('unit-redis');

    // assert
    expect(loaded?.policy.redisCommands).toEqual(['GET', 'TTL']);
  });

  it('keeps the allowlist through the CLI so a pinned profile refuses unlisted reads', () => {
    // arrange
    const { stateRoot } = tempStateRoot();
    const env = { TAPROOT_STATE_ROOT: stateRoot, TAPROOT_MASTER_KEY: 'test-key' };
    runCli(['datasource', 'add', '--name', 'qa-pinned', '--kind', 'redis', '--env', 'qa', '--service', 'pinned', '--host', '127.0.0.1', '--port', '6379', '--redis-commands', 'get,ttl'], env);

    // act
    const shown = JSON.parse(runCli(['datasource', 'show', 'qa-pinned'], env).stdout).data;

    // assert
    expect(shown.policy.redisCommands).toEqual(['GET', 'TTL']);
  });

  it('names the allowed verbs when refusing an unlisted read', async () => {
    // arrange
    stubRedisCli('printf "v\\n"\n');
    const datasource = profileWith(['GET', 'TTL']);

    // act
    const run = redisPlugin.execute!({ datasource, query: 'HGETALL user:1', capability: 'executeRead', timeoutMs: 5000, sessionTimeZone: '+00:00', signal: undefined }, {});

    // assert
    await expect(run).rejects.toThrow(/allowed: GET, TTL/);
  });
});
