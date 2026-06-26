import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { _resetProtoCachesForTest, loadProtobufRoot } from '../src/core/proto-loader.js';
import { buildRequestSkeleton } from '../src/core/grpc-introspect.js';
import { validateGrpcRequest } from '../src/core/grpc-proto-validate.js';
import { grpcPlugin } from '../src/plugins-builtins/grpc/index.js';
import type { DatasourceProfile, QueryRequest } from '../src/types/core.js';

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `taproot-${name}-`));
}

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

describe('validateGrpcRequest', () => {
  beforeEach(() => _resetProtoCachesForTest());

  it('returns null for a valid payload', async () => {
    const dir = tmpDir('grpcv-valid');
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
    const dir = tmpDir('grpcv-unknown');
    writeFixtureProto(dir);
    const { protobufRoot } = await loadProtobufRoot(dir);
    const err = validateGrpcRequest(protobufRoot, 'taproot.test.GetItemRequest', {
      itemid: 'abc',
    });
    expect(err).not.toBeNull();
    expect(err!.field).toBe('itemid');
    expect(err!.message).toMatch(/unknown field 'itemid' on taproot\.test\.GetItemRequest/);
    expect(err!.message).toMatch(/Did you mean 'item_id'/);
  });

  it('flags wrong scalar type (number instead of string)', async () => {
    const dir = tmpDir('grpcv-scalar-string');
    writeFixtureProto(dir);
    const { protobufRoot } = await loadProtobufRoot(dir);
    const err = validateGrpcRequest(protobufRoot, 'taproot.test.GetItemRequest', {
      item_id: 12345,
    });
    expect(err).not.toBeNull();
    expect(err!.field).toBe('item_id');
    expect(err!.expected).toBe('string');
    expect(err!.message).toMatch(/expected string at item_id/);
  });

  it('flags wrong scalar type (string for int64 that is not numeric)', async () => {
    const dir = tmpDir('grpcv-scalar-int');
    writeFixtureProto(dir);
    const { protobufRoot } = await loadProtobufRoot(dir);
    const err = validateGrpcRequest(protobufRoot, 'taproot.test.GetItemRequest', {
      address: { postal_code: 'not-a-number' },
    });
    expect(err).not.toBeNull();
    expect(err!.field).toBe('address.postal_code');
    expect(err!.expected).toBe('int64');
  });

  it('flags bad enum string with closest-value suggestion', async () => {
    const dir = tmpDir('grpcv-enum');
    writeFixtureProto(dir);
    const { protobufRoot } = await loadProtobufRoot(dir);
    const err = validateGrpcRequest(protobufRoot, 'taproot.test.GetItemRequest', {
      status: 'ACTIV',
    });
    expect(err).not.toBeNull();
    expect(err!.field).toBe('status');
    expect(err!.expected).toBe('enum:taproot.test.Status');
    expect(err!.message).toMatch(/Did you mean 'ACTIVE'/);
  });

  it('identifies the full path for unknown nested fields', async () => {
    const dir = tmpDir('grpcv-nested');
    writeFixtureProto(dir);
    const { protobufRoot } = await loadProtobufRoot(dir);
    const err = validateGrpcRequest(protobufRoot, 'taproot.test.GetItemRequest', {
      address: { cityname: 'foo' },
    });
    expect(err).not.toBeNull();
    expect(err!.field).toBe('address.cityname');
    expect(err!.message).toMatch(/unknown field 'cityname' on taproot\.test\.Address/);
    expect(err!.message).toMatch(/Did you mean 'city_name'/);
  });

  it('accepts skeleton output as round-trippable', async () => {
    const dir = tmpDir('grpcv-skeleton');
    writeFixtureProto(dir);
    const { protobufRoot } = await loadProtobufRoot(dir);
    const skeleton = buildRequestSkeleton(protobufRoot, 'taproot.test.GetItemRequest');
    expect(validateGrpcRequest(protobufRoot, 'taproot.test.GetItemRequest', skeleton)).toBeNull();
  });
});

describe('grpcPlugin proto pre-flight validation', () => {
  beforeEach(() => _resetProtoCachesForTest());

  function makeRequest(opts: { protoRoot: string; requestJson?: string; skipProtoValidate?: boolean }): QueryRequest {
    const datasource: DatasourceProfile = {
      name: 'unit-grpc',
      kind: 'grpc',
      env: 'unit',
      service: 'items',
      tags: [],
      connection: { host: '127.0.0.1', port: 65535 },
      credentialRef: 'unit-grpc',
      connectors: [],
      policy: { allowRead: true, allowMutate: false, allowedCapabilities: ['executeRead'] },
      resolverHints: { protoRoot: opts.protoRoot },
      updatedAt: new Date().toISOString(),
    } as unknown as DatasourceProfile;
    return {
      datasource,
      query: 'taproot.test.ItemService/GetItem',
      capability: 'executeRead',
      timeoutMs: 5000,
      sessionTimeZone: '+00:00',
      pluginParams: {
        protoRoot: opts.protoRoot,
        requestJson: opts.requestJson,
        skipProtoValidate: opts.skipProtoValidate,
      },
    } as QueryRequest;
  }

  it('throws BAD_INPUT before opening a channel for unknown fields', async () => {
    const dir = tmpDir('grpc-plugin-unknown');
    writeFixtureProto(dir);
    const request = makeRequest({
      protoRoot: dir,
      requestJson: JSON.stringify({ itemid: 'abc' }),
    });
    await expect(grpcPlugin.execute!(request, {})).rejects.toMatchObject({
      message: expect.stringMatching(/^BAD_INPUT: unknown field 'itemid'/),
      code: 'BAD_INPUT',
      details: {
        field: 'itemid',
        nextCommand: expect.stringMatching(/taproot grpc describe .* --method GetItem --skeleton/),
      },
    });
  });

  it('--skip-proto-validate bypasses the validator', async () => {
    const dir = tmpDir('grpc-plugin-skip');
    writeFixtureProto(dir);
    const request = makeRequest({
      protoRoot: dir,
      requestJson: JSON.stringify({ itemid: 'abc' }),
      skipProtoValidate: true,
    });
    await expect(grpcPlugin.execute!(request, {})).rejects.not.toThrow(/^BAD_INPUT:/);
  });
});
