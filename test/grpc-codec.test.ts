import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import protobuf from 'protobufjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { grpcPlugin } from '../src/plugins-builtins/grpc/index.js';
import type { DatasourceProfile, QueryRequest, QueryResult } from '../src/types/core.js';

const PROTO = `syntax = "proto3";
package taproot.test;

enum ProfileStatus {
  UNKNOWN = 0;
  ACTIVE = 1;
  SUSPENDED = 2;
}

message GetProfileRequest {
  string id = 1;
  ProfileStatus status = 2;
}

message Profile {
  string id = 1;
  optional Address address = 2;

  message Address {
    string city = 1;
  }
}

service ProfileService {
  rpc GetProfile(GetProfileRequest) returns (Profile);
}
`;

let protoRoot = '';
let port = 0;
let server: grpc.Server;
let received: { status?: number } = {};

beforeAll(async () => {
  protoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'taproot-grpc-codec-'));
  const protoFile = path.join(protoRoot, 'profile.proto');
  fs.writeFileSync(protoFile, PROTO, 'utf8');
  const serverRoot = protobuf.loadSync(protoFile);
  const Request = serverRoot.lookupType('taproot.test.GetProfileRequest');
  const Response = serverRoot.lookupType('taproot.test.Profile');
  server = new grpc.Server();
  server.addService(
    {
      GetProfile: {
        path: '/taproot.test.ProfileService/GetProfile',
        requestStream: false,
        responseStream: false,
        requestSerialize: (value: object) => Buffer.from(Request.encode(Request.fromObject(value)).finish()),
        requestDeserialize: (bytes: Buffer) => Request.toObject(Request.decode(bytes)),
        responseSerialize: (value: object) => Buffer.from(Response.encode(Response.fromObject(value)).finish()),
        responseDeserialize: (bytes: Buffer) => Response.toObject(Response.decode(bytes)),
      },
    },
    {
      GetProfile: (call: grpc.ServerUnaryCall<{ id: string; status?: number }, unknown>, callback: grpc.sendUnaryData<unknown>) => {
        received = call.request;
        callback(null, { id: call.request.id, address: { city: 'Lagos' } });
      },
    },
  );
  port = await new Promise<number>((resolve, reject) => {
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, bound) => (err ? reject(err) : resolve(bound)));
  });
});

afterAll(() => {
  server?.forceShutdown();
});

function getProfile(body: Record<string, unknown>): Promise<QueryResult> {
  const datasource = {
    name: 'unit-grpc-codec',
    kind: 'grpc',
    env: 'unit',
    service: 'profiles',
    tags: [],
    connection: { host: '127.0.0.1', port },
    credentialRef: 'unit-grpc-codec',
    connectors: [],
    policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
    resolverHints: { protoRoot },
    updatedAt: new Date().toISOString(),
  } as unknown as DatasourceProfile;
  return grpcPlugin.execute!(
    {
      datasource,
      query: 'taproot.test.ProfileService/GetProfile',
      capability: 'executeRead',
      timeoutMs: 5000,
      sessionTimeZone: '+00:00',
      pluginParams: { protoRoot, requestJson: JSON.stringify(body) },
    } as QueryRequest,
    {},
  );
}

describe('grpcPlugin message codec', () => {
  it.each(['ACTIVE', 1])('sends enum value %j as its number', async (status) => {
    // act
    await getProfile({ id: 'p1', status });

    // assert
    expect(received.status).toBe(1);
  });

  it('decodes an optional nested message the server sends', async () => {
    // act
    const result = await getProfile({ id: 'p1' });

    // assert
    expect(result.result.rows[0].value).toMatchObject({ id: 'p1', address: { city: 'Lagos' } });
  });
});
