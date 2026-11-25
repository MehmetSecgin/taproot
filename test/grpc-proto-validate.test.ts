import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { loadProtobufRoot, resetProtoCacheForTest } from '../src/core/proto-loader.js';
import { buildRequestSkeleton } from '../src/core/grpc-introspect.js';
import { validateGrpcRequest } from '../src/core/grpc-proto-validate.js';
import { grpcPlugin } from '../src/plugins-builtins/grpc/index.js';
import type { QueryRequest, QueryResult } from '../src/types/plugin.js';
import { testDatasource } from './helpers/datasource.js';
import { makeTempDir } from './helpers/grpc-introspect-fixtures.js';

function writeFixtureProto(root: string): void {
  fs.mkdirSync(root, { recursive: true });
  const proto = `syntax = "proto3";
package taproot.test;

enum Status {
  STATUS_UNKNOWN = 0;
  ACTIVE = 1;
  RETIRED = 2;
}

message Address {
  string city_name = 1;
  int64 postal_code = 2;
}

message GetItemRequest {
  string item_id = 1;
  Status status = 2;
  Address address = 3;
  repeated string tags = 4;
}

message GetItemResponse {
  string id = 1;
}

service ItemService {
  rpc GetItem(GetItemRequest) returns (GetItemResponse);
}
`;
  fs.writeFileSync(path.join(root, 'item.proto'), proto, 'utf8');
}

function makeRequest(opts: { protoRoot: string; requestJson?: string; skipProtoValidate?: boolean }): QueryRequest {
  return {
    datasource: testDatasource('grpc', 65_535, { protoRoot: opts.protoRoot }),
    query: 'taproot.test.ItemService/GetItem',
    capability: 'executeRead',
    timeoutMs: 5000,
    sessionTimeZone: '+00:00',
    pluginParams: {
      protoRoot: opts.protoRoot,
      requestJson: opts.requestJson,
      skipProtoValidate: opts.skipProtoValidate,
    },
    signal: undefined,
  };
}

async function executeGrpc(request: QueryRequest): Promise<QueryResult> {
  if (!grpcPlugin.execute) {
    throw new Error('grpc plugin has no execute');
  }
  return grpcPlugin.execute(request, {});
}

describe('grpc request validation', () => {
  beforeEach(() => {
    resetProtoCacheForTest();
  });

  it('returns null for a valid payload', async () => {
    const dir = makeTempDir('grpcv-valid');
    writeFixtureProto(dir);
    const { protobufRoot } = await loadProtobufRoot(dir);
    const err = validateGrpcRequest(protobufRoot, 'taproot.test.GetItemRequest', {
      item_id: 'abc',
      status: 'ACTIVE',
      address: { city_name: 'foo', postal_code: 1 },
      tags: ['a', 'b'],
    });
    expect(err).toBeNull();
  });

  it('flags unknown top-level fields with a Did you mean suggestion', async () => {
    const dir = makeTempDir('grpcv-unknown');
    writeFixtureProto(dir);
    const { protobufRoot } = await loadProtobufRoot(dir);
    const err = validateGrpcRequest(protobufRoot, 'taproot.test.GetItemRequest', {
      itemid: 'abc',
    });
    expect(err).toMatchObject({ field: 'itemid' });
    expect(err?.message).toMatch(/unknown field 'itemid' on taproot\.test\.GetItemRequest/u);
    expect(err?.message).toMatch(/Did you mean 'item_id'/u);
  });

  it('rejects a camelCase key the request encoder would drop', async () => {
    // arrange
    const dir = makeTempDir('grpcv-camel');
    writeFixtureProto(dir);
    const { protobufRoot } = await loadProtobufRoot(dir);

    // act
    const err = validateGrpcRequest(protobufRoot, 'taproot.test.GetItemRequest', { itemId: 'abc' });

    // assert
    expect(err).toMatchObject({ field: 'itemId' });
    expect(err?.message).toMatch(/Did you mean 'item_id'/u);
  });

  it('flags wrong scalar type (number instead of string)', async () => {
    const dir = makeTempDir('grpcv-scalar-string');
    writeFixtureProto(dir);
    const { protobufRoot } = await loadProtobufRoot(dir);
    const err = validateGrpcRequest(protobufRoot, 'taproot.test.GetItemRequest', {
      item_id: 12_345,
    });
    expect(err).toMatchObject({ field: 'item_id', expected: 'string' });
    expect(err?.message).toMatch(/expected string at item_id/u);
  });

  it('flags wrong scalar type (string for int64 that is not numeric)', async () => {
    const dir = makeTempDir('grpcv-scalar-int');
    writeFixtureProto(dir);
    const { protobufRoot } = await loadProtobufRoot(dir);
    const err = validateGrpcRequest(protobufRoot, 'taproot.test.GetItemRequest', {
      address: { postal_code: 'not-a-number' },
    });
    expect(err).toMatchObject({ field: 'address.postal_code', expected: 'int64' });
  });

  it('flags bad enum string with closest-value suggestion', async () => {
    const dir = makeTempDir('grpcv-enum');
    writeFixtureProto(dir);
    const { protobufRoot } = await loadProtobufRoot(dir);
    const err = validateGrpcRequest(protobufRoot, 'taproot.test.GetItemRequest', {
      status: 'ACTIV',
    });
    expect(err).toMatchObject({ field: 'status', expected: 'enum:taproot.test.Status' });
    expect(err?.message).toMatch(/Did you mean 'ACTIVE'/u);
  });

  it('identifies the full path for unknown nested fields', async () => {
    const dir = makeTempDir('grpcv-nested');
    writeFixtureProto(dir);
    const { protobufRoot } = await loadProtobufRoot(dir);
    const err = validateGrpcRequest(protobufRoot, 'taproot.test.GetItemRequest', {
      address: { cityname: 'foo' },
    });
    expect(err).toMatchObject({ field: 'address.cityname' });
    expect(err?.message).toMatch(/unknown field 'cityname' on taproot\.test\.Address/u);
    expect(err?.message).toMatch(/Did you mean 'city_name'/u);
  });

  it('accepts skeleton output as round-trippable', async () => {
    const dir = makeTempDir('grpcv-skeleton');
    writeFixtureProto(dir);
    const { protobufRoot } = await loadProtobufRoot(dir);
    const skeleton = buildRequestSkeleton(protobufRoot, 'taproot.test.GetItemRequest');
    expect(validateGrpcRequest(protobufRoot, 'taproot.test.GetItemRequest', skeleton)).toBeNull();
  });
});

describe('grpcPlugin proto pre-flight validation', () => {
  beforeEach(() => {
    resetProtoCacheForTest();
  });

  it('throws BAD_INPUT before opening a channel for unknown fields', async () => {
    const dir = makeTempDir('grpc-plugin-unknown');
    writeFixtureProto(dir);
    const request = makeRequest({
      protoRoot: dir,
      requestJson: JSON.stringify({ itemid: 'abc' }),
    });
    await expect(executeGrpc(request)).rejects.toThrow(/^BAD_INPUT: unknown field 'itemid'.*taproot grpc describe .* --method GetItem --skeleton/u);
    await expect(executeGrpc(request)).rejects.toMatchObject({ code: 'BAD_INPUT', details: { field: 'itemid' } });
  });

  it('--skip-proto-validate bypasses the validator', async () => {
    const dir = makeTempDir('grpc-plugin-skip');
    writeFixtureProto(dir);
    const request = makeRequest({
      protoRoot: dir,
      requestJson: JSON.stringify({ itemid: 'abc' }),
      skipProtoValidate: true,
    });
    await expect(executeGrpc(request)).rejects.not.toThrow(/^BAD_INPUT:/u);
  });
});
