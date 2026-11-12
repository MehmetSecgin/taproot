import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadGrpcPackage } from '../src/core/proto-loader.js';
import { grpcPlugin } from '../src/plugins-builtins/grpc/index.js';
import type { DatasourceProfile, QueryRequest } from '../src/types/core.js';

const PROTO = `syntax = "proto3";
package taproot.test;

message GetProfileRequest {
  string id = 1;
}

message Profile {
  string name = 1;
}

service ProfileService {
  rpc GetProfile(GetProfileRequest) returns (Profile);
  rpc ListProfiles(GetProfileRequest) returns (stream Profile);
}
`;

const cancelledMethods: string[] = [];
const startedMethods: string[] = [];
let protoRoot = '';
let port = 0;
let server: grpc.Server;

function neverAnswer(method: string) {
  return (call: grpc.ServerUnaryCall<unknown, unknown> | grpc.ServerWritableStream<unknown, unknown>) => {
    startedMethods.push(method);
    call.on('cancelled', () => cancelledMethods.push(method));
  };
}

beforeAll(async () => {
  protoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-grpc-abort-'));
  fs.writeFileSync(path.join(protoRoot, 'profile.proto'), PROTO, 'utf8');
  const bundle = await loadGrpcPackage(protoRoot);
  const pkg = bundle.grpcPackage as unknown as { taproot: { test: { ProfileService: { service: grpc.ServiceDefinition } } } };
  server = new grpc.Server();
  server.addService(pkg.taproot.test.ProfileService.service, {
    GetProfile: neverAnswer('GetProfile'),
    ListProfiles: neverAnswer('ListProfiles'),
  });
  port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, bound) => (err ? reject(err) : resolve(bound)));
  });
});

afterAll(() => {
  server?.forceShutdown();
});

function callProfiles(method: string, signal: AbortSignal): QueryRequest {
  const datasource = {
    name: 'unit-grpc-abort',
    kind: 'grpc',
    env: 'unit',
    service: 'profiles',
    tags: [],
    connection: { host: '127.0.0.1', port },
    credentialRef: 'unit-grpc-abort',
    connectors: [],
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    resolverHints: { protoRoot },
    updatedAt: new Date().toISOString(),
  } as unknown as DatasourceProfile;
  return {
    datasource,
    query: `taproot.test.ProfileService/${method}`,
    capability: 'executeRead',
    timeoutMs: 30_000,
    sessionTimeZone: '+00:00',
    pluginParams: { protoRoot, requestJson: JSON.stringify({ id: '1' }) },
    signal,
  };
}

describe('grpcPlugin abort', () => {
  it.each(['GetProfile', 'ListProfiles'])('cancels %s on the server and fails with the abort reason', async (method) => {
    // arrange
    const caller = new AbortController();
    const pending = grpcPlugin.execute!(callProfiles(method, caller.signal), {});
    await vi.waitFor(() => expect(startedMethods).toContain(method));

    // act
    caller.abort(new Error('client disconnected'));

    // assert
    await expect(pending).rejects.toThrow('client disconnected');
    await vi.waitFor(() => expect(cancelledMethods).toContain(method));
  });
});
