import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadGrpcPackage } from '../src/core/proto-loader.js';
import { grpcPlugin } from '../src/plugins-builtins/grpc/index.js';
import type { DatasourceProfile, QueryRequest } from '../src/types/core.js';

const PROTO = `syntax = "proto3";
package taproot.test;

message Profile {
  string id = 1;
  string name = 2;
}

message GetProfileRequest {
  string id = 1;
}

message GetProfileResponse {
  Profile profile = 1;
}

message ListProfilesRequest {
  int32 count = 1;
}

message CountProfilesResponse {
  int32 count = 1;
}

service ProfileService {
  rpc GetProfile(GetProfileRequest) returns (GetProfileResponse);
  rpc ListProfiles(ListProfilesRequest) returns (stream Profile);
  rpc CountProfiles(stream GetProfileRequest) returns (CountProfilesResponse);
  rpc LookupProfiles(stream GetProfileRequest) returns (stream GetProfileResponse);
}
`;

type Call = grpc.ServerDuplexStream<{ id: string }, unknown>;

let protoRoot = '';
let port = 0;
let server: grpc.Server;

beforeAll(async () => {
  protoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-grpc-stream-'));
  fs.writeFileSync(path.join(protoRoot, 'profile.proto'), PROTO, 'utf8');
  const bundle = await loadGrpcPackage(protoRoot);
  const pkg = bundle.grpcPackage as unknown as { taproot: { test: { ProfileService: { service: grpc.ServiceDefinition } } } };
  server = new grpc.Server();
  server.addService(pkg.taproot.test.ProfileService.service, {
    GetProfile: (call: grpc.ServerUnaryCall<{ id: string }, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      callback(null, { profile: { id: call.request.id, name: `profile-${call.request.id}` } });
    },
    ListProfiles: (call: grpc.ServerWritableStream<{ count: number }, unknown>) => {
      for (let i = 0; i < call.request.count; i += 1) call.write({ id: String(i), name: `profile-${i}` });
      call.end();
    },
    CountProfiles: (call: grpc.ServerReadableStream<{ id: string }, unknown>, callback: grpc.sendUnaryData<unknown>) => {
      let count = 0;
      call.on('data', () => { count += 1; });
      call.on('end', () => callback(null, { count }));
    },
    LookupProfiles: (call: Call) => {
      let failed = false;
      call.on('data', (req: { id: string }) => {
        if (failed) return;
        if (req.id === 'fail') {
          failed = true;
          call.emit('error', { code: grpc.status.INTERNAL, details: 'lookup failed' });
          return;
        }
        call.write({ profile: { id: req.id, name: `profile-${req.id}` } });
      });
      call.on('end', () => {
        if (!failed) call.end();
      });
    },
  });
  port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, bound) => (err ? reject(err) : resolve(bound)));
  });
});

afterAll(() => {
  server?.forceShutdown();
});

function makeRequest(method: string, body: unknown): QueryRequest {
  const datasource = {
    name: 'unit-grpc-stream',
    kind: 'grpc',
    env: 'unit',
    service: 'profiles',
    tags: [],
    connection: { host: '127.0.0.1', port },
    credentialRef: 'unit-grpc-stream',
    connectors: [],
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    resolverHints: { protoRoot },
    updatedAt: new Date().toISOString(),
  } as unknown as DatasourceProfile;
  return {
    datasource,
    query: `taproot.test.ProfileService/${method}`,
    capability: 'executeRead',
    timeoutMs: 5000,
    sessionTimeZone: '+00:00',
    pluginParams: { protoRoot, requestJson: JSON.stringify(body) },
  } as QueryRequest;
}

describe('grpcPlugin streaming calls', () => {
  it('returns one row per bidi response in arrival order', async () => {
    // act
    const result = await grpcPlugin.execute!(makeRequest('LookupProfiles', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]), {});

    // assert
    expect(result.result.columns).toEqual(['seq', 'value']);
    expect(result.result.rows).toEqual([
      { seq: 0, value: { profile: { id: 'a', name: 'profile-a' } } },
      { seq: 1, value: { profile: { id: 'b', name: 'profile-b' } } },
      { seq: 2, value: { profile: { id: 'c', name: 'profile-c' } } },
    ]);
    expect(result.warnings).toEqual([]);
  });

  it('sends a single object to a bidi method as a one-message stream', async () => {
    // act
    const result = await grpcPlugin.execute!(makeRequest('LookupProfiles', { id: 'solo' }), {});

    // assert
    expect(result.result.rows).toEqual([{ seq: 0, value: { profile: { id: 'solo', name: 'profile-solo' } } }]);
  });

  it('fails a bidi call that the server aborts and keeps the rows received before it', async () => {
    // act
    const call = grpcPlugin.execute!(makeRequest('LookupProfiles', [{ id: 'a' }, { id: 'fail' }, { id: 'c' }]), {});

    // assert
    await expect(call).rejects.toMatchObject({
      message: expect.stringMatching(/^grpc_code=13 lookup failed \(stream failed after 1 responses, \d requests sent\)$/),
      details: {
        stream: { received: 1, grpcCode: 13 },
        receivedRows: [{ seq: 0, value: { profile: { id: 'a', name: 'profile-a' } } }],
      },
    });
  });

  it('collects the single response of a client-streaming call', async () => {
    // act
    const result = await grpcPlugin.execute!(makeRequest('CountProfiles', [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]), {});

    // assert
    expect(result.result.rows).toEqual([{ seq: 0, value: { count: 4 } }]);
  });

  it('collects every message of a server-streaming call', async () => {
    // act
    const result = await grpcPlugin.execute!(makeRequest('ListProfiles', { count: 3 }), {});

    // assert
    expect(result.result.rows.map((row) => row.seq)).toEqual([0, 1, 2]);
    expect(result.result.rows[2]).toEqual({ seq: 2, value: { id: '2', name: 'profile-2' } });
  });

  it('stops a server stream at the message limit and warns', async () => {
    // act
    const result = await grpcPlugin.execute!(makeRequest('ListProfiles', { count: 1005 }), {});

    // assert
    expect(result.result.rows).toHaveLength(1000);
    expect(result.warnings).toEqual([expect.stringMatching(/^response stream stopped at 1000 messages/)]);
  });

  it('keeps unary calls on the single value column', async () => {
    // act
    const result = await grpcPlugin.execute!(makeRequest('GetProfile', { id: 'u' }), {});

    // assert
    expect(result.result.columns).toEqual(['value']);
    expect(result.result.rows).toEqual([{ value: { profile: { id: 'u', name: 'profile-u' } } }]);
  });

  it('rejects an array for a method that takes one request message', async () => {
    // act
    const call = grpcPlugin.execute!(makeRequest('ListProfiles', [{ count: 1 }]), {});

    // assert
    await expect(call).rejects.toMatchObject({
      code: 'BAD_INPUT',
      message: expect.stringMatching(/ListProfiles takes one request message, not an array/),
    });
  });

  it('names the failing message index when a stream element fails validation', async () => {
    // act
    const call = grpcPlugin.execute!(makeRequest('LookupProfiles', [{ id: 'a' }, { idd: 'b' }]), {});

    // assert
    await expect(call).rejects.toMatchObject({
      code: 'BAD_INPUT',
      message: expect.stringMatching(/^BAD_INPUT: request\[1\]: unknown field 'idd'/),
      details: { field: '[1].idd' },
    });
  });

  it('rejects a stream above the message limit before opening a channel', async () => {
    // arrange
    const messages = Array.from({ length: 1001 }, (_, i) => ({ id: String(i) }));

    // act
    const call = grpcPlugin.execute!(makeRequest('LookupProfiles', messages), {});

    // assert
    await expect(call).rejects.toMatchObject({
      code: 'BAD_INPUT',
      message: expect.stringMatching(/stream request has 1001 messages; the limit is 1000 per call/),
    });
  });
});
