import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, beforeEach } from 'vitest';
import { _resetProtoCachesForTest, loadProtobufRoot, loadGrpcPackage } from '../src/core/proto-loader.js';
import { describeProto, describeProtoRoot, listServices, expandMessage } from '../src/core/grpc-introspect.js';

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
  string city = 1;
  string country = 2;
}

message Profile {
  string name = 1;
  repeated string nicknames = 2;
  Address address = 3;
  Status status = 4;
  map<string, string> labels = 5;
  oneof contact {
    string email = 6;
    string phone = 7;
  }
}

message GetProfileRequest {
  string id = 1;
}

message GetProfileResponse {
  Profile profile = 1;
}

message ListProfilesRequest {}

message ListProfilesResponse {
  repeated Profile profiles = 1;
}

service ProfileService {
  rpc GetProfile(GetProfileRequest) returns (GetProfileResponse);
  rpc ListProfiles(ListProfilesRequest) returns (ListProfilesResponse);
}
`;
  fs.writeFileSync(path.join(root, 'profile.proto'), proto, 'utf8');
}

describe('proto-loader', () => {
  beforeEach(() => _resetProtoCachesForTest());

  it('loads a protobufjs root and caches by normalized path', async () => {
    const dir = tmpDir('proto-loader');
    writeFixtureProto(dir);
    const a = await loadProtobufRoot(dir);
    const b = await loadProtobufRoot(dir);
    expect(a.protobufRoot).toBe(b.protobufRoot);
    expect(a.files.length).toBe(1);
  });

  it('loads a grpc-js package and exposes service ctors', async () => {
    const dir = tmpDir('grpc-loader');
    writeFixtureProto(dir);
    const bundle = await loadGrpcPackage(dir);
    const pkg = bundle.grpcPackage as Record<string, any>;
    expect(typeof pkg.taproot?.test?.ProfileService).toBe('function');
  });

  it('throws when no proto files found', async () => {
    const dir = tmpDir('proto-empty');
    await expect(loadProtobufRoot(dir)).rejects.toThrow(/no \.proto files/);
  });
});

describe('grpc-introspect', () => {
  beforeEach(() => _resetProtoCachesForTest());

  it('lists services and methods', async () => {
    const dir = tmpDir('introspect-list');
    writeFixtureProto(dir);
    const { protobufRoot } = await loadProtobufRoot(dir);
    const services = listServices(protobufRoot);
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe('taproot.test.ProfileService');
    const methodNames = services[0].methods.map((m) => m.name).sort();
    expect(methodNames).toEqual(['GetProfile', 'ListProfiles']);
    const get = services[0].methods.find((m) => m.name === 'GetProfile')!;
    expect(get.requestType).toBe('taproot.test.GetProfileRequest');
    expect(get.responseType).toBe('taproot.test.GetProfileResponse');
    expect(get.requestStream).toBeUndefined();
  });

  it('expands message shapes with nested types, enums, repeated, map, oneof', async () => {
    const dir = tmpDir('introspect-expand');
    writeFixtureProto(dir);
    const { protobufRoot } = await loadProtobufRoot(dir);
    const { messages, enums } = expandMessage(protobufRoot, 'taproot.test.GetProfileResponse');
    expect(messages['taproot.test.GetProfileResponse']).toBeTruthy();
    expect(messages['taproot.test.Profile']).toBeTruthy();
    expect(messages['taproot.test.Address']).toBeTruthy();
    expect(enums['taproot.test.Status']).toEqual({
      name: 'taproot.test.Status',
      values: { STATUS_UNKNOWN: 0, ACTIVE: 1, RETIRED: 2 },
    });
    const profile = messages['taproot.test.Profile'];
    const fieldByName = Object.fromEntries(profile.fields.map((f) => [f.name, f]));
    expect(fieldByName.nicknames.repeated).toBe(true);
    expect(fieldByName.address.type).toBe('message:taproot.test.Address');
    expect(fieldByName.status.type).toBe('enum:taproot.test.Status');
    expect(fieldByName.labels.type).toBe('map<string,string>');
    expect(fieldByName.labels.repeated).toBe(true);
    expect(fieldByName.email.oneof).toBe('contact');
    expect(fieldByName.phone.oneof).toBe('contact');
  });

  it('describeProto filters by service and method', async () => {
    const dir = tmpDir('introspect-filter');
    writeFixtureProto(dir);
    const { protobufRoot } = await loadProtobufRoot(dir);
    const all = describeProto(protobufRoot);
    expect(all.services).toHaveLength(1);
    expect(Object.keys(all.messages).length).toBeGreaterThan(0);

    const onlyGet = describeProto(protobufRoot, {
      service: 'taproot.test.ProfileService',
      method: 'GetProfile',
    });
    expect(onlyGet.messages['taproot.test.GetProfileRequest']).toBeTruthy();
    expect(onlyGet.messages['taproot.test.ListProfilesResponse']).toBeUndefined();
  });

  it('caps message expansion at maxDepth', async () => {
    const dir = tmpDir('introspect-depth');
    writeFixtureProto(dir);
    const { protobufRoot } = await loadProtobufRoot(dir);
    const shallow = expandMessage(protobufRoot, 'taproot.test.GetProfileResponse', { maxDepth: 1 });
    expect(shallow.messages['taproot.test.GetProfileResponse']).toBeTruthy();
    expect(shallow.messages['taproot.test.Profile']).toBeTruthy();
    expect(shallow.messages['taproot.test.Address']).toBeUndefined();
  });

  it('describeProtoRoot end-to-end loads + describes', async () => {
    const dir = tmpDir('introspect-e2e');
    writeFixtureProto(dir);
    const descriptor = await describeProtoRoot(dir, { service: 'taproot.test.ProfileService' });
    expect(descriptor.services[0].methods).toHaveLength(2);
    expect(descriptor.messages['taproot.test.Profile']).toBeTruthy();
  });
});
