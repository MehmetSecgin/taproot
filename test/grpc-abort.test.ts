import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { callUnary } from '../src/plugins-builtins/grpc/call.js';
import { grpcPlugin } from '../src/plugins-builtins/grpc/index.js';
import type { QueryRequest } from '../src/types/core.js';
import { testDatasource } from './helpers/datasource.js';
import { profileServiceDefinition, startGrpcServer } from './helpers/grpc-server.js';

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
  ({ server, port } = await startGrpcServer(await profileServiceDefinition(protoRoot), {
    GetProfile: neverAnswer('GetProfile'),
    ListProfiles: neverAnswer('ListProfiles'),
  }));
});

afterAll(() => {
  server?.forceShutdown();
});

function callProfiles(method: string, signal: AbortSignal): QueryRequest {
  return {
    datasource: testDatasource('grpc', port, { protoRoot }),
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

describe('callUnary', () => {
  it('settles when the client answers before the call object is returned', async () => {
    // arrange
    const caller = new AbortController();
    const client = {
      GetProfile: (_payload: unknown, _metadata: unknown, _options: unknown, callback: (err: null, response: unknown) => void) => {
        callback(null, { name: 'Ada' });
        return { cancel: () => undefined };
      },
    };

    // act
    const response = callUnary(client, { name: 'GetProfile', requestType: 'taproot.test.GetProfileRequest', responseType: 'taproot.test.Profile' }, { id: '1' }, undefined, 5000, caller.signal);

    // assert
    await expect(response).resolves.toEqual({ name: 'Ada' });
  });
});
