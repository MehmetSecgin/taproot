import path from 'node:path';
import type { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import protobuf from 'protobufjs';
import { describe, expect, it, onTestFinished } from 'vitest';
import { grpcPlugin } from '../src/plugins-builtins/grpc/index.js';
import type { QueryResult } from '../src/types/plugin.js';
import { protoRootWith } from './helpers/grpc-streaming-support.js';
import { testDatasource } from './helpers/datasource.js';
import { startGrpcServer } from './helpers/grpc-server.js';
import { executeOf } from './helpers/mysql-row-cap-support.js';

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

type CodecServer = {
  port: number;
  protoRoot: string;
  received: { status?: number };
};

async function startCodecServer(): Promise<CodecServer> {
  const protoRoot = protoRootWith('taproot-grpc-codec-', PROTO);
  const protoFile = path.join(protoRoot, 'profile.proto');
  const serverRoot = protobuf.loadSync(protoFile);
  const Request = serverRoot.lookupType('taproot.test.GetProfileRequest');
  const Response = serverRoot.lookupType('taproot.test.Profile');
  const received: { status?: number } = {};
  const { server, port } = await startGrpcServer(
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
      GetProfile: (call: ServerUnaryCall<{ id: string; status?: number }, unknown>, reply: sendUnaryData<unknown>) => {
        received.status = call.request.status;
        reply(null, { id: call.request.id, address: { city: 'Lagos' } });
      },
    },
  );
  onTestFinished(() => {
    server.forceShutdown();
  });
  return { port, protoRoot, received };
}

async function getProfile(server: CodecServer, body: Record<string, unknown>): Promise<QueryResult> {
  const { port, protoRoot } = server;
  return executeOf(grpcPlugin)(
    {
      datasource: testDatasource('grpc', port, { protoRoot }),
      query: 'taproot.test.ProfileService/GetProfile',
      capability: 'executeRead',
      timeoutMs: 5000,
      sessionTimeZone: '+00:00',
      pluginParams: { protoRoot, requestJson: JSON.stringify(body) },
      signal: undefined,
    },
    {},
  );
}

describe('grpcPlugin message codec', () => {
  it.each(['ACTIVE', 1])('sends enum value %j as its number', async (status) => {
    // arrange
    const server = await startCodecServer();

    // act
    await getProfile(server, { id: 'p1', status });

    // assert
    expect(server.received.status).toBe(1);
  });

  it('decodes an optional nested message the server sends', async () => {
    // arrange
    const server = await startCodecServer();

    // act
    const result = await getProfile(server, { id: 'p1' });

    // assert
    expect(result.result.rows[0][0]).toMatchObject({ id: 'p1', address: { city: 'Lagos' } });
  });
});
