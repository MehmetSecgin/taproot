import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it, beforeEach } from 'vitest';
import { _resetProtoCachesForTest, loadProtobufRoot, loadGrpcPackage } from '../src/core/proto-loader.js';
import {
  describeProto,
  listServices,
  expandMessage,
  resolveName,
  suggestNames,
  searchMethods,
  buildRequestSkeleton,
} from '../src/core/grpc-introspect.js';

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

  it('reports unresolved cross-repo imports with the importing file and a fix hint', async () => {
    const dir = tmpDir('proto-missing-import');
    fs.writeFileSync(
      path.join(dir, 'main.proto'),
      'syntax = "proto3";\npackage demo;\nimport "common.proto";\nimport "google/protobuf/timestamp.proto";\nmessage Req { string id = 1; }\n',
      'utf8',
    );
    await expect(loadProtobufRoot(dir)).rejects.toThrow(/unresolved proto import/);
    await expect(loadProtobufRoot(dir)).rejects.toThrow(/common\.proto/);
    // google/protobuf/* is bundled and must not be flagged
    await expect(loadProtobufRoot(dir)).rejects.not.toThrow(/timestamp\.proto/);
  });

  it('resolves cross-module imports across multiple roots', async () => {
    const rootA = tmpDir('proto-root-a');
    const rootB = tmpDir('proto-root-b');
    fs.writeFileSync(
      path.join(rootA, 'main.proto'),
      'syntax = "proto3";\npackage demo;\nimport "common.proto";\nmessage Req { shared.Common c = 1; }\n',
      'utf8',
    );
    fs.writeFileSync(
      path.join(rootB, 'common.proto'),
      'syntax = "proto3";\npackage shared;\nmessage Common { string x = 1; }\n',
      'utf8',
    );
    const bundle = await loadProtobufRoot(`${rootA},${rootB}`);
    expect(bundle.files.length).toBe(2);
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

  it('loads and describes a proto root end-to-end', async () => {
    const dir = tmpDir('introspect-e2e');
    writeFixtureProto(dir);
    const descriptor = describeProto((await loadProtobufRoot(dir)).protobufRoot, { service: 'taproot.test.ProfileService' });
    expect(descriptor.services[0].methods).toHaveLength(2);
    expect(descriptor.messages['taproot.test.Profile']).toBeTruthy();
  });
});

describe('grpc-introspect discovery helpers', () => {
  const services = ['com.example.catalog.v1.CatalogService', 'taproot.test.ProfileService'];

  it('resolveName matches exact, short name, and substring', () => {
    expect(resolveName('taproot.test.ProfileService', services).match).toBe('taproot.test.ProfileService');
    expect(resolveName('ProfileService', services).match).toBe('taproot.test.ProfileService');
    expect(resolveName('catalogservice', services).match).toBe('com.example.catalog.v1.CatalogService');
    expect(resolveName('catalog', services).match).toBe('com.example.catalog.v1.CatalogService');
  });

  it('resolveName returns candidates when ambiguous and has no match', () => {
    const both = resolveName('service', services);
    expect(both.match).toBeUndefined();
    expect(both.candidates).toEqual(services);
  });

  it('suggestNames ranks closest by edit distance', () => {
    const out = suggestNames('ProfilService', services, 1);
    expect(out[0]).toBe('taproot.test.ProfileService');
  });

  it('searchMethods finds by service/method/message substring', async () => {
    const dir = tmpDir('introspect-search');
    writeFixtureProto(dir);
    const { protobufRoot } = await loadProtobufRoot(dir);
    const byMethod = searchMethods(protobufRoot, 'getprofile');
    expect(byMethod.map((m) => m.method)).toEqual(['GetProfile']);
    const byMessage = searchMethods(protobufRoot, 'ListProfilesResponse');
    expect(byMessage.map((m) => m.method)).toEqual(['ListProfiles']);
    expect(searchMethods(protobufRoot, '').length).toBe(2);
  });

  it('buildRequestSkeleton emits an editable typed example', async () => {
    const dir = tmpDir('introspect-skeleton');
    writeFixtureProto(dir);
    const { protobufRoot } = await loadProtobufRoot(dir);
    const skeleton = buildRequestSkeleton(protobufRoot, 'taproot.test.GetProfileRequest') as Record<string, unknown>;
    expect(skeleton).toEqual({ id: '<string>' });
  });

  it('grpc describe --skeleton prints a ready-to-run query call', () => {
    const dir = tmpDir('introspect-skeleton-call');
    writeFixtureProto(dir);
    const out = spawnSync(
      process.execPath,
      [path.join(process.cwd(), 'dist', 'index.js'), 'grpc', 'describe', '--proto-root', dir, '--method', 'GetProfile', '--skeleton', '--pluck', 'data.requestSkeletons'],
      { encoding: 'utf8', env: { ...process.env, TAPROOT_STATE_ROOT: tmpDir('introspect-state') } },
    );
    expect(JSON.parse(out.stdout)[0].call).toBe(
      `taproot query --datasource <datasource> --query "taproot.test.ProfileService/GetProfile" --request-json '{"id":"<string>"}'`,
    );
  });

  it('buildRequestSkeleton expands nested messages, repeated, enum, map, oneof', async () => {
    const dir = tmpDir('introspect-skeleton-deep');
    writeFixtureProto(dir);
    const { protobufRoot } = await loadProtobufRoot(dir);
    const resp = buildRequestSkeleton(protobufRoot, 'taproot.test.ListProfilesResponse') as Record<string, unknown>;
    const profiles = resp.profiles as Record<string, unknown>[];
    expect(Array.isArray(profiles)).toBe(true);
    const p = profiles[0];
    expect(p.name).toBe('<string>');
    expect(p.nicknames).toEqual(['<string>']);
    expect(p.address).toEqual({ city: '<string>', country: '<string>' });
    expect(p.status).toBe('STATUS_UNKNOWN');
    expect(p.labels).toEqual({ '<key>': '<string>' });
    expect(p.email).toBe('<string>');
  });
});
