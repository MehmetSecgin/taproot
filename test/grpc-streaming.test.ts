import { status } from '@grpc/grpc-js';
import type { ServerDuplexStream, ServerReadableStream, ServerUnaryCall, ServerWritableStream, sendUnaryData } from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';
import { grpcPlugin } from '../src/plugins-builtins/grpc/index.js';
import type { QueryRequest, QueryResult } from '../src/types/plugin.js';
import { protoRootWith, rejectionOf, startProfileServer } from './helpers/grpc-streaming-support.js';
import { testDatasource } from './helpers/datasource.js';
import { executeOf } from './helpers/mysql-row-cap-support.js';

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

type Call = ServerDuplexStream<{ id: string }, unknown>;

const MESSAGE_LIMIT = 1000;

function lookupProfiles(call: Call): void {
  let failed = false;
  call.on('data', (message: { id: string }) => {
    if (failed) {
      return;
    }
    if (message.id === 'fail') {
      failed = true;
      call.emit('error', { code: status.INTERNAL, details: 'lookup failed' });
      return;
    }
    call.write({ profile: { id: message.id, name: `profile-${message.id}` } });
  });
  call.on('end', () => {
    if (!failed) {
      call.end();
    }
  });
}

async function startStreamingServer(): Promise<{ port: number; protoRoot: string }> {
  const protoRoot = protoRootWith('taproot-grpc-stream-', PROTO);
  const port = await startProfileServer(protoRoot, {
    GetProfile: (call: ServerUnaryCall<{ id: string }, unknown>, reply: sendUnaryData<unknown>) => {
      reply(null, { profile: { id: call.request.id, name: `profile-${call.request.id}` } });
    },
    ListProfiles: (call: ServerWritableStream<{ count: number }, unknown>) => {
      for (let index = 0; index < call.request.count; index += 1) {
        call.write({ id: String(index), name: `profile-${index}` });
      }
      call.end();
    },
    CountProfiles: (call: ServerReadableStream<{ id: string }, unknown>, reply: sendUnaryData<unknown>) => {
      let count = 0;
      call.on('data', () => {
        count += 1;
      });
      call.on('end', () => {
        reply(null, { count });
      });
    },
    LookupProfiles: lookupProfiles,
  });
  return { port, protoRoot };
}

async function makeRequest(method: string, body: unknown): Promise<QueryRequest> {
  const { port, protoRoot } = await startStreamingServer();
  return {
    datasource: testDatasource('grpc', port, { protoRoot }),
    query: `taproot.test.ProfileService/${method}`,
    capability: 'executeRead',
    timeoutMs: 5000,
    sessionTimeZone: '+00:00',
    pluginParams: { protoRoot, requestJson: JSON.stringify(body) },
    signal: undefined,
  };
}

async function callMethod(method: string, body: unknown): Promise<QueryResult> {
  return executeOf(grpcPlugin)(await makeRequest(method, body), {});
}

describe('grpcPlugin streaming calls', () => {
  it('returns one row per bidi response in arrival order', async () => {
    // act
    const result = await callMethod('LookupProfiles', [{ id: 'a' }, { id: 'b' }, { id: 'c' }]);

    // assert
    expect(result.result.columns).toStrictEqual(['seq', 'value']);
    expect(result.result.rows).toStrictEqual([
      [0, { profile: { id: 'a', name: 'profile-a' } }],
      [1, { profile: { id: 'b', name: 'profile-b' } }],
      [2, { profile: { id: 'c', name: 'profile-c' } }],
    ]);
    expect(result.warnings).toStrictEqual([]);
  });

  it('sends a single object to a bidi method as a one-message stream', async () => {
    // act
    const result = await callMethod('LookupProfiles', { id: 'solo' });

    // assert
    expect(result.result.rows).toStrictEqual([[0, { profile: { id: 'solo', name: 'profile-solo' } }]]);
  });

  it('fails a bidi call that the server aborts and keeps the rows received before it', async () => {
    // act
    const error = await rejectionOf(callMethod('LookupProfiles', [{ id: 'a' }, { id: 'fail' }, { id: 'c' }]));

    // assert
    expect(error.message).toMatch(/^grpc_code=13 lookup failed \(stream failed after 1 responses, \d requests sent\)$/u);
    expect(error).toMatchObject({
      details: {
        stream: { received: 1, grpcCode: 13 },
        receivedRows: [{ seq: 0, value: { profile: { id: 'a', name: 'profile-a' } } }],
      },
    });
  });

  it('collects the single response of a client-streaming call', async () => {
    // act
    const result = await callMethod('CountProfiles', [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }]);

    // assert
    expect(result.result.rows).toStrictEqual([[0, { count: 4 }]]);
  });

  it('collects every message of a server-streaming call', async () => {
    // act
    const result = await callMethod('ListProfiles', { count: 3 });

    // assert
    expect(result.result.rows.map(([seq]) => seq)).toStrictEqual([0, 1, 2]);
    expect(result.result.rows[2]).toStrictEqual([2, { id: '2', name: 'profile-2' }]);
  });

  it('stops a server stream at the message limit and warns', async () => {
    // act
    const result = await callMethod('ListProfiles', { count: MESSAGE_LIMIT + 5 });

    // assert
    expect(result.result.rows).toHaveLength(MESSAGE_LIMIT);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatch(/^response stream stopped at 1000 messages/u);
  });

  it('keeps unary calls on the single value column', async () => {
    // act
    const result = await callMethod('GetProfile', { id: 'u' });

    // assert
    expect(result.result.columns).toStrictEqual(['value']);
    expect(result.result.rows).toStrictEqual([[{ profile: { id: 'u', name: 'profile-u' } }]]);
    expect(result.meta).toBeUndefined();
  });

  it('accepts the short service name and method name in another case', async () => {
    // arrange
    const request = await makeRequest('GetProfile', { id: 'u' });

    // act
    const result = await executeOf(grpcPlugin)({ ...request, query: 'profileservice/getprofile' }, {});

    // assert
    expect(result.query.native).toBe('taproot.test.ProfileService/GetProfile');
    expect(result.result.rows).toStrictEqual([[{ profile: { id: 'u', name: 'profile-u' } }]]);
  });

  it('rejects an array for a method that takes one request message', async () => {
    // act
    const error = await rejectionOf(callMethod('ListProfiles', [{ count: 1 }]));

    // assert
    expect(error).toMatchObject({ code: 'BAD_INPUT' });
    expect(error.message).toMatch(/ListProfiles takes one request message, not an array/u);
  });

  it('names the failing message index when a stream element fails validation', async () => {
    // act
    const error = await rejectionOf(callMethod('LookupProfiles', [{ id: 'a' }, { idd: 'b' }]));

    // assert
    expect(error).toMatchObject({ code: 'BAD_INPUT', details: { field: '[1].idd' } });
    expect(error.message).toMatch(/^BAD_INPUT: request\[1\]: unknown field 'idd'/u);
  });

  it('rejects a stream above the message limit before opening a channel', async () => {
    // arrange
    const messages = Array.from({ length: MESSAGE_LIMIT + 1 }, (_, index) => ({ id: String(index) }));

    // act
    const error = await rejectionOf(callMethod('LookupProfiles', messages));

    // assert
    expect(error).toMatchObject({ code: 'BAD_INPUT' });
    expect(error.message).toMatch(/stream request has 1001 messages; the limit is 1000 per call/u);
  });
});
