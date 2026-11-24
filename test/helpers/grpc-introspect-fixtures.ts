import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isProtoMessage } from '../../src/core/proto-node-shapes.js';
import type { ProtobufRoot } from '../../src/core/proto-loader.js';
import { parseJson } from './parse-json.js';

export const PROFILE_SERVICE = 'taproot.test.ProfileService';

export function makeTempDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `taproot-${name}-`));
}

export function writeProtoFile(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
}

export function writeFixtureProto(root: string): void {
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

export function fieldNamesOf(root: ProtobufRoot, typeName: string): string[] {
  const found = root.lookup(typeName);
  if (!isProtoMessage(found)) {
    throw new TypeError(`${typeName} is not a message type`);
  }
  return found.fieldsArray.map((field) => field.name);
}

export function parseSkeletonCalls(stdout: string): { call: string }[];
export function parseSkeletonCalls(stdout: string): unknown {
  return parseJson(stdout);
}

function parseMessageMap(stdout: string): Record<string, unknown>;
function parseMessageMap(stdout: string): unknown {
  return parseJson(stdout);
}

export function parseMessageNames(stdout: string): string[] {
  return Object.keys(parseMessageMap(stdout));
}
