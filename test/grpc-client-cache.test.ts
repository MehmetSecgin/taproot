import fs from 'node:fs';
import path from 'node:path';
import { Client, credentials } from '@grpc/grpc-js';
import type { ServerUnaryCall, sendUnaryData } from '@grpc/grpc-js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { grpcPlugin } from '../src/plugins-builtins/grpc/index.js';
import type { QueryRequest } from '../src/types/plugin.js';
import { protoRootWith, startProfileServer } from './helpers/grpc-streaming-support.js';
import { testDatasource } from './helpers/datasource.js';
import { executeOf } from './helpers/mysql-row-cap-support.js';

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
const PROTO_ROOT_PREFIX = 'taproot-grpc-client-';

async function startAdaServer(): Promise<number> {
  return startProfileServer(protoRootWith(PROTO_ROOT_PREFIX, NAME_AND_CITY), {
    GetProfile: (_call: ServerUnaryCall<unknown, unknown>, reply: sendUnaryData<unknown>) => {
      reply(null, { name: 'Ada', city: 'Lyon' });
    },
  });
}

function getProfile(port: number, datasourceProtoRoot: string, protoRoot: string): QueryRequest {
  return {
    datasource: testDatasource('grpc', port, { protoRoot: datasourceProtoRoot }),
    query: 'taproot.test.ProfileService/GetProfile',
    capability: 'executeRead',
    timeoutMs: 5000,
    sessionTimeZone: '+00:00',
    pluginParams: { protoRoot, requestJson: JSON.stringify({ id: '1' }) },
    signal: undefined,
  };
}

describe('grpcPlugin client cache', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('decodes with the definitions from --proto-root when it differs from the datasource root', async () => {
    // arrange
    const port = await startAdaServer();
    const datasourceRoot = protoRootWith(PROTO_ROOT_PREFIX, NAME_ONLY);
    const overrideRoot = protoRootWith(PROTO_ROOT_PREFIX, NAME_AND_CITY);
    await executeOf(grpcPlugin)(getProfile(port, datasourceRoot, datasourceRoot), {});

    // act
    const result = await executeOf(grpcPlugin)(getProfile(port, datasourceRoot, overrideRoot), {});

    // assert
    expect(result.result.rows).toStrictEqual([[{ name: 'Ada', city: 'Lyon' }]]);
  });

  it('closes the old client and decodes with the edited .proto', async () => {
    // arrange
    const port = await startAdaServer();
    const root = protoRootWith(PROTO_ROOT_PREFIX, NAME_ONLY);
    await executeOf(grpcPlugin)(getProfile(port, root, root), {});
    fs.writeFileSync(path.join(root, 'profile.proto'), NAME_AND_CITY, 'utf8');
    const close = vi.spyOn(Client.prototype, 'close');

    // act
    const result = await executeOf(grpcPlugin)(getProfile(port, root, root), {});

    // assert
    expect(result.result.rows).toStrictEqual([[{ name: 'Ada', city: 'Lyon' }]]);
    expect(close.mock.calls.map(() => 'closed')).toStrictEqual(['closed']);
  });

  it('reuses one client across tokens', async () => {
    // arrange
    const port = await startAdaServer();
    const root = protoRootWith(PROTO_ROOT_PREFIX, NAME_ONLY);
    await executeOf(grpcPlugin)(getProfile(port, root, root), { token: 'first' });
    const newChannelCredentials = vi.spyOn(credentials, 'createInsecure');

    // act
    await executeOf(grpcPlugin)(getProfile(port, root, root), { token: 'second' });

    // assert
    expect(newChannelCredentials).not.toHaveBeenCalled();
  });
});

describe('grpcPlugin unary call', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('clears its backup deadline timer once the call returns', async () => {
    // arrange
    const port = await startAdaServer();
    const root = protoRootWith(PROTO_ROOT_PREFIX, NAME_AND_CITY);
    const setTimer = vi.spyOn(globalThis, 'setTimeout');
    const clearTimer = vi.spyOn(globalThis, 'clearTimeout');

    // act
    await executeOf(grpcPlugin)(getProfile(port, root, root), {});

    // assert
    const backupCall = setTimer.mock.calls.findIndex(([, delay]) => delay === 5500);
    expect(clearTimer).toHaveBeenCalledWith(setTimer.mock.results[backupCall].value);
  });
});
