import { beforeEach, describe, expect, it } from 'vitest';
import { loadProtobufRoot, resetProtoCacheForTest } from '../src/core/proto-loader.js';
import {
  buildRequestSkeleton,
  describeProto,
  expandMessage,
  listServices,
  searchMethods,
} from '../src/core/grpc-introspect.js';
import { resolveName, suggestNames } from '../src/core/name-match.js';
import type { ProtobufRoot } from '../src/core/proto-loader.js';
import { PROFILE_SERVICE, makeTempDir, parseMessageNames, parseSkeletonCalls, writeFixtureProto } from './helpers/grpc-introspect-fixtures.js';
import { runCli } from './helpers/cli.js';
import { tempStateRoot } from './helpers/state-root.js';

async function loadFixtureRoot(name: string): Promise<ProtobufRoot> {
  const dir = makeTempDir(name);
  writeFixtureProto(dir);
  const { protobufRoot } = await loadProtobufRoot(dir);
  return protobufRoot;
}

describe('grpc-introspect', () => {
  beforeEach(() => {
    resetProtoCacheForTest();
  });

  it('lists every service with its methods', async () => {
    // arrange
    const protobufRoot = await loadFixtureRoot('introspect-list');

    // act
    const services = listServices(protobufRoot);

    // assert
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe(PROFILE_SERVICE);
    expect(services[0].methods.map((method) => method.name).toSorted()).toStrictEqual(['GetProfile', 'ListProfiles']);
  });

  it('describes a unary method by its request and response types', async () => {
    // arrange
    const protobufRoot = await loadFixtureRoot('introspect-method');

    // act
    const getProfile = listServices(protobufRoot)[0].methods.find((method) => method.name === 'GetProfile');

    // assert
    expect(getProfile).toMatchObject({
      requestType: 'taproot.test.GetProfileRequest',
      responseType: 'taproot.test.GetProfileResponse',
    });
    expect(getProfile?.requestStream).toBeUndefined();
  });

  it('expands the messages and enums reachable from a message', async () => {
    // arrange
    const protobufRoot = await loadFixtureRoot('introspect-expand');

    // act
    const { messages, enums } = expandMessage(protobufRoot, 'taproot.test.GetProfileResponse');

    // assert
    expect(Object.keys(messages).toSorted()).toStrictEqual(['taproot.test.Address', 'taproot.test.GetProfileResponse', 'taproot.test.Profile']);
    expect(enums['taproot.test.Status']).toStrictEqual({
      name: 'taproot.test.Status',
      values: { STATUS_UNKNOWN: 0, ACTIVE: 1, RETIRED: 2 },
    });
  });

  it('expands message fields with repeated, enum, map and oneof markers', async () => {
    // arrange
    const protobufRoot = await loadFixtureRoot('introspect-fields');

    // act
    const { messages } = expandMessage(protobufRoot, 'taproot.test.GetProfileResponse');

    // assert
    const fieldByName = Object.fromEntries(messages['taproot.test.Profile'].fields.map((field) => [field.name, field]));
    expect(fieldByName.nicknames).toMatchObject({ repeated: true });
    expect(fieldByName.address.type).toBe('message:taproot.test.Address');
    expect(fieldByName.status.type).toBe('enum:taproot.test.Status');
    expect(fieldByName.labels).toMatchObject({ type: 'map<string,string>', repeated: true });
    expect(fieldByName.email.oneof).toBe('contact');
    expect(fieldByName.phone.oneof).toBe('contact');
  });

  it('describeProto describes every service and message when unfiltered', async () => {
    // arrange
    const protobufRoot = await loadFixtureRoot('introspect-unfiltered');

    // act
    const descriptor = describeProto(protobufRoot);

    // assert
    expect(descriptor.services).toHaveLength(1);
    expect(Object.keys(descriptor.messages).length).toBeGreaterThan(0);
  });

  it('describeProto filters by service and method', async () => {
    // arrange
    const protobufRoot = await loadFixtureRoot('introspect-filter');

    // act
    const onlyGet = describeProto(protobufRoot, { service: PROFILE_SERVICE, method: 'GetProfile' });

    // assert
    expect(onlyGet.messages['taproot.test.GetProfileRequest']).toBeDefined();
    expect(onlyGet.messages['taproot.test.ListProfilesResponse']).toBeUndefined();
  });

  it('caps message expansion at maxDepth', async () => {
    // arrange
    const protobufRoot = await loadFixtureRoot('introspect-depth');

    // act
    const shallow = expandMessage(protobufRoot, 'taproot.test.GetProfileResponse', { maxDepth: 1 });

    // assert
    expect(shallow.messages['taproot.test.GetProfileResponse']).toBeDefined();
    expect(shallow.messages['taproot.test.Profile']).toBeDefined();
    expect(shallow.messages['taproot.test.Address']).toBeUndefined();
  });

  it('loads and describes a proto root end-to-end', async () => {
    // arrange
    const protobufRoot = await loadFixtureRoot('introspect-e2e');

    // act
    const descriptor = describeProto(protobufRoot, { service: PROFILE_SERVICE });

    // assert
    expect(descriptor.services[0].methods).toHaveLength(2);
    expect(descriptor.messages['taproot.test.Profile']).toBeDefined();
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
    expect(both.candidates).toStrictEqual(services);
  });

  it('suggestNames ranks closest by edit distance', () => {
    const [closest] = suggestNames('ProfilService', services, 1);
    expect(closest).toBe('taproot.test.ProfileService');
  });

  it('finds methods whose service, method or message name contains the term', async () => {
    // arrange
    const protobufRoot = await loadFixtureRoot('introspect-search');

    // act
    const byMethod = searchMethods(protobufRoot, 'getprofile');
    const byMessage = searchMethods(protobufRoot, 'ListProfilesResponse');
    const matchesForEmptyTerm = searchMethods(protobufRoot, '');

    // assert
    expect(byMethod.map((match) => match.method)).toStrictEqual(['GetProfile']);
    expect(byMessage.map((match) => match.method)).toStrictEqual(['ListProfiles']);
    expect(matchesForEmptyTerm).toHaveLength(2);
  });

  it('buildRequestSkeleton emits an editable typed example', async () => {
    // arrange
    const protobufRoot = await loadFixtureRoot('introspect-skeleton');

    // act
    const skeleton = buildRequestSkeleton(protobufRoot, 'taproot.test.GetProfileRequest');

    // assert
    expect(skeleton).toStrictEqual({ id: '<string>' });
  });

  it('grpc describe --skeleton prints a ready-to-run query call', () => {
    // arrange
    const dir = makeTempDir('introspect-skeleton-call');
    writeFixtureProto(dir);

    // act
    const out = runCli(
      ['grpc', 'describe', '--proto-root', dir, '--method', 'GetProfile', '--skeleton', '--pluck', 'data.requestSkeletons'],
      { TAPROOT_STATE_ROOT: tempStateRoot().stateRoot },
    );

    // assert
    expect(parseSkeletonCalls(out.stdout)[0].call).toBe(
      `taproot query --datasource <datasource> --query "taproot.test.ProfileService/GetProfile" --request-json '{"id":"<string>"}'`,
    );
  });

  it('grpc describe --max-depth 0 lists only the request and response messages', () => {
    // arrange
    const dir = makeTempDir('introspect-depth-zero');
    writeFixtureProto(dir);

    // act
    const out = runCli(
      ['grpc', 'describe', '--proto-root', dir, '--method', 'GetProfile', '--max-depth', '0', '--pluck', 'data.messages'],
      { TAPROOT_STATE_ROOT: tempStateRoot().stateRoot },
    );

    // assert
    expect(parseMessageNames(out.stdout).toSorted()).toStrictEqual(['taproot.test.GetProfileRequest', 'taproot.test.GetProfileResponse']);
  });

  it('buildRequestSkeleton expands nested messages, repeated, enum, map, oneof', async () => {
    // arrange
    const protobufRoot = await loadFixtureRoot('introspect-skeleton-deep');

    // act
    const skeleton = buildRequestSkeleton(protobufRoot, 'taproot.test.ListProfilesResponse');

    // assert
    expect(skeleton).toMatchObject({
      profiles: [
        {
          name: '<string>',
          nicknames: ['<string>'],
          address: { city: '<string>', country: '<string>' },
          status: 'STATUS_UNKNOWN',
          labels: { '<key>': '<string>' },
          email: '<string>',
        },
      ],
    });
  });
});
