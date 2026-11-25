import type { ServerUnaryCall, ServerWritableStream } from '@grpc/grpc-js';
import { describe, expect, it, vi } from 'vitest';
import { callUnary } from '../src/plugins-builtins/grpc/call.js';
import { grpcPlugin } from '../src/plugins-builtins/grpc/index.js';
import type { QueryRequest } from '../src/types/plugin.js';
import { protoRootWith, startProfileServer } from './helpers/grpc-streaming-support.js';
import { testDatasource } from './helpers/datasource.js';
import { executeOf } from './helpers/mysql-row-cap-support.js';

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

type NeverAnsweringServer = {
  port: number;
  protoRoot: string;
  cancelledMethods: string[];
  startedMethods: string[];
};

async function startNeverAnsweringServer(): Promise<NeverAnsweringServer> {
  const protoRoot = protoRootWith('taproot-grpc-abort-', PROTO);
  const cancelledMethods: string[] = [];
  const startedMethods: string[] = [];
  const neverAnswer = (method: string) => (call: ServerUnaryCall<unknown, unknown> | ServerWritableStream<unknown, unknown>): void => {
    startedMethods.push(method);
    call.on('cancelled', () => {
      cancelledMethods.push(method);
    });
  };
  const port = await startProfileServer(protoRoot, {
    GetProfile: neverAnswer('GetProfile'),
    ListProfiles: neverAnswer('ListProfiles'),
  });
  return { port, protoRoot, cancelledMethods, startedMethods };
}

function callProfiles(server: NeverAnsweringServer, method: string, signal: AbortSignal): QueryRequest {
  const { port, protoRoot } = server;
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
    const server = await startNeverAnsweringServer();
    const caller = new AbortController();
    const pending = executeOf(grpcPlugin)(callProfiles(server, method, caller.signal), {});
    await vi.waitFor(() => {
      expect(server.startedMethods).toContain(method);
    });

    // act
    caller.abort(new Error('client disconnected'));

    // assert
    await expect(pending).rejects.toThrow('client disconnected');
    await vi.waitFor(() => {
      expect(server.cancelledMethods).toContain(method);
    });
  });
});

describe('grpc unary call helper', () => {
  it('settles when the client answers before the call object is returned', async () => {
    // arrange
    const caller = new AbortController();
    const cancelledCalls: string[] = [];
    const client = {
      GetProfile: (_payload: unknown, _metadata: unknown, ...rest: [unknown, (error: null, response: unknown) => void]): { cancel: () => void } => {
        const [, onResponse] = rest;
        onResponse(null, { name: 'Ada' });
        return {
          cancel: (): void => {
            cancelledCalls.push('cancel');
          },
        };
      },
    };
    const method = { name: 'GetProfile', requestType: 'taproot.test.GetProfileRequest', responseType: 'taproot.test.Profile' };

    // act
    const response = callUnary({ client, method, metadata: undefined, deadlineMs: 5000, signal: caller.signal }, { id: '1' });

    // assert
    await expect(response).resolves.toStrictEqual({ name: 'Ada' });
  });
});
