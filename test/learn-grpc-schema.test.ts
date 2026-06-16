import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppContext } from '../src/core/app.js';
import { ensureGrpcSchemaSnapshot } from '../src/commands/learn.js';
import { PluginRegistry } from '../src/plugins/registry.js';
import { LearningStore } from '../src/store/learning.js';
import { DatasourceStore } from '../src/store/datasources.js';
import { _resetProtoCachesForTest } from '../src/core/proto-loader.js';

function writeFixtureProto(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(
    path.join(root, 'profile.proto'),
    `syntax = "proto3";
package taproot.test;
message GetProfileRequest { string id = 1; }
message GetProfileResponse { string name = 1; }
service ProfileService {
  rpc GetProfile(GetProfileRequest) returns (GetProfileResponse);
}
`,
    'utf8',
  );
}

function makeContext(protoRoot: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-grpc-schema-'));
  const configDir = path.join(root, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const ds = {
    name: 'qa-profile-grpc',
    kind: 'grpc',
    env: 'qa',
    namespace: 'develop',
    service: 'profile-grpc',
    tags: [],
    connection: { host: '127.0.0.1', port: 6565 },
    credentialRef: 'qa:grpc:profile',
    connectors: [],
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    resolverHints: { protoRoot },
    updatedAt: new Date().toISOString(),
    confidence: 0.9,
  };
  fs.writeFileSync(path.join(configDir, 'datasources.json'), JSON.stringify([ds]));
  fs.writeFileSync(path.join(configDir, 'templates.json'), '[]');
  fs.writeFileSync(path.join(configDir, 'deterministic-config.json'), JSON.stringify({ serviceAliases: {} }));

  const ctx: AppContext = {
    paths: {
      stateRoot: root,
      configDir,
      runtimeConfigFile: path.join(configDir, 'deterministic-config.json'),
      datasourceFile: path.join(configDir, 'datasources.json'),
      credentialFile: path.join(configDir, 'credentials.json.enc'),
      templatesFile: path.join(configDir, 'templates.json'),
      cacheDir: path.join(root, 'cache'),
      runsDir: path.join(root, 'runs'),
      runsLedgerDir: path.join(root, 'learning', 'runs-ledger'),
      learningDir: path.join(root, 'learning'),
      kbDir: path.join(root, 'kb'),
    },
    datasourceStore: new DatasourceStore(path.join(configDir, 'datasources.json')),
    templateStore: {} as any,
    cardStore: {} as any,
    credentialStore: { get: async () => ({}) } as any,
    kbStore: { resolveConnection: () => undefined } as any,
    learningStore: new LearningStore(path.join(root, 'learning')),
    runtimeConfigStore: { serviceAliases: () => ({}) } as any,
    pluginRegistry: new PluginRegistry(),
    jsonMode: true,
    noColor: true,
    noAnimations: true,
    verbose: false,
  };
  return { ctx };
}

describe('learn ensure-schema (grpc)', () => {
  it('introspects the proto root once when no grpc schema is cached', async () => {
    _resetProtoCachesForTest();
    const protoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-grpc-proto-'));
    writeFixtureProto(protoRoot);
    const { ctx } = makeContext(protoRoot);

    const out = await ensureGrpcSchemaSnapshot(ctx, { datasource: 'qa-profile-grpc' });
    expect(out.ensuredBy).toBe('refreshed-introspection');
    expect(out.serviceCount).toBe(1);
    expect(out.methodCount).toBe(1);
    expect(out.methods[0]).toMatchObject({
      service: 'taproot.test.ProfileService',
      method: 'GetProfile',
      request: 'taproot.test.GetProfileRequest',
      response: 'taproot.test.GetProfileResponse',
    });
    expect(out.messageCount).toBeGreaterThanOrEqual(2);
  });

  it('returns cached grpc schema without re-introspecting on subsequent calls', async () => {
    _resetProtoCachesForTest();
    const protoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-grpc-proto-'));
    writeFixtureProto(protoRoot);
    const { ctx } = makeContext(protoRoot);

    await ensureGrpcSchemaSnapshot(ctx, { datasource: 'qa-profile-grpc' });
    // delete the proto root so a re-introspection would fail; cache must serve it
    fs.rmSync(protoRoot, { recursive: true, force: true });
    _resetProtoCachesForTest();

    const out = await ensureGrpcSchemaSnapshot(ctx, { datasource: 'qa-profile-grpc' });
    expect(out.ensuredBy).toBe('cached-learning');
    expect(out.methodCount).toBe(1);
  });

  it('includes messages and enums when detailed', async () => {
    _resetProtoCachesForTest();
    const protoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-grpc-proto-'));
    writeFixtureProto(protoRoot);
    const { ctx } = makeContext(protoRoot);

    const out = await ensureGrpcSchemaSnapshot(ctx, { datasource: 'qa-profile-grpc', detailed: true });
    expect(out.messages?.['taproot.test.GetProfileRequest']).toBeTruthy();
  });

  it('returns unresolved when the targeted datasource does not exist', async () => {
    _resetProtoCachesForTest();
    const protoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-grpc-proto-'));
    writeFixtureProto(protoRoot);
    const { ctx } = makeContext(protoRoot);

    const out = await ensureGrpcSchemaSnapshot(ctx, { datasource: 'does-not-exist' });
    expect(out.ensuredBy).toBe('unresolved');
    expect(out.emptyReason).toBe('datasource_unresolved');
  });
});
