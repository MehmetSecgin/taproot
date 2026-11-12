import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadGrpcPackage } from '../src/core/proto-loader.js';
import { grpcPlugin } from '../src/plugins-builtins/grpc/index.js';
import type { DatasourceProfile, QueryRequest } from '../src/types/core.js';

function profileProto(responseFields: string): string {
  return `syntax = "proto3";
package taproot.test;

message GetProfileRequest {
  string id = 1;
}

message GetProfileResponse {
${responseFields}
}

service ProfileService {
  rpc GetProfile(GetProfileRequest) returns (GetProfileResponse);
}
`;
}

const NAME_ONLY = profileProto('  string name = 1;');
const NAME_AND_CITY = profileProto('  string name = 1;\n  string city = 2;');

function protoRootWith(proto: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-grpc-client-'));
  fs.writeFileSync(path.join(dir, 'profile.proto'), proto, 'utf8');
  return dir;
}

let port = 0;
let server: grpc.Server;

beforeAll(async () => {
  const bundle = await loadGrpcPackage(protoRootWith(NAME_AND_CITY));
  const pkg = bundle.grpcPackage as unknown as { taproot: { test: { ProfileService: { service: grpc.ServiceDefinition } } } };
  server = new grpc.Server();
  server.addService(pkg.taproot.test.ProfileService.service, {
    GetProfile: (_call: grpc.ServerUnaryCall<unknown, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      callback(null, { name: 'Ada', city: 'Lyon' });
    },
  });
  port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, bound) => (err ? reject(err) : resolve(bound)));
  });
});

afterAll(() => {
  server?.forceShutdown();
});

afterEach(() => {
  vi.restoreAllMocks();
});

function getProfile(datasourceProtoRoot: string, protoRoot: string): QueryRequest {
  const datasource = {
    name: 'unit-grpc-client',
    kind: 'grpc',
    env: 'unit',
    service: 'profiles',
    tags: [],
    connection: { host: '127.0.0.1', port },
    credentialRef: 'unit-grpc-client',
    connectors: [],
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    resolverHints: { protoRoot: datasourceProtoRoot },
    updatedAt: new Date().toISOString(),
  } as unknown as DatasourceProfile;
  return {
    datasource,
    query: 'taproot.test.ProfileService/GetProfile',
    capability: 'executeRead',
    timeoutMs: 5000,
    sessionTimeZone: '+00:00',
    pluginParams: { protoRoot, requestJson: JSON.stringify({ id: '1' }) },
    signal: undefined,
  } as QueryRequest;
}

describe('grpcPlugin client cache', () => {
  it('decodes with the definitions from --proto-root when it differs from the datasource root', async () => {
    // arrange
    const datasourceRoot = protoRootWith(NAME_ONLY);
    const overrideRoot = protoRootWith(NAME_AND_CITY);
    await grpcPlugin.execute!(getProfile(datasourceRoot, datasourceRoot), {});

    // act
    const result = await grpcPlugin.execute!(getProfile(datasourceRoot, overrideRoot), {});

    // assert
    expect(result.result.rows).toEqual([[{ name: 'Ada', city: 'Lyon' }]]);
  });

  it('closes the old client and decodes with the edited .proto', async () => {
    // arrange
    const root = protoRootWith(NAME_ONLY);
    await grpcPlugin.execute!(getProfile(root, root), {});
    fs.writeFileSync(path.join(root, 'profile.proto'), NAME_AND_CITY, 'utf8');
    const close = vi.spyOn(grpc.Client.prototype, 'close');

    // act
    const result = await grpcPlugin.execute!(getProfile(root, root), {});

    // assert
    expect(result.result.rows).toEqual([[{ name: 'Ada', city: 'Lyon' }]]);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('reuses one client across tokens', async () => {
    // arrange
    const root = protoRootWith(NAME_ONLY);
    await grpcPlugin.execute!(getProfile(root, root), { token: 'first' });
    const newChannelCredentials = vi.spyOn(grpc.credentials, 'createInsecure');

    // act
    await grpcPlugin.execute!(getProfile(root, root), { token: 'second' });

    // assert
    expect(newChannelCredentials).not.toHaveBeenCalled();
  });
});

describe('grpcPlugin unary call', () => {
  it('clears its backup deadline timer once the call returns', async () => {
    // arrange
    const root = protoRootWith(NAME_AND_CITY);
    const setTimer = vi.spyOn(globalThis, 'setTimeout');
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout');

    // act
    await grpcPlugin.execute!(getProfile(root, root), {});

    // assert
    const backupCall = setTimer.mock.calls.findIndex(([, delay]) => delay === 5500);
    expect(clearTimer).toHaveBeenCalledWith(setTimer.mock.results[backupCall].value);
  });
});
