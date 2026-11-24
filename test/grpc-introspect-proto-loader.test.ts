import path from 'node:path';
import protoLoader from '@grpc/proto-loader';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loadGrpcPackage, loadProtobufRoot, lookupServiceCtor, resetProtoCacheForTest } from '../src/core/proto-loader.js';
import { PROFILE_SERVICE, fieldNamesOf, makeTempDir, writeFixtureProto, writeProtoFile } from './helpers/grpc-introspect-fixtures.js';

const PROTO_HEADER = 'syntax = "proto3";\n';

function writeProtoWithMissingCommonImport(dir: string): void {
  writeProtoFile(
    path.join(dir, 'main.proto'),
    `${PROTO_HEADER}package demo;\nimport "common.proto";\nimport "google/protobuf/timestamp.proto";\nmessage Req { string id = 1; }\n`,
  );
}

describe('proto-loader', () => {
  beforeEach(() => {
    resetProtoCacheForTest();
  });

  it('loads a protobufjs root and caches by normalized path', async () => {
    // arrange
    const dir = makeTempDir('proto-loader');
    writeFixtureProto(dir);

    // act
    const first = await loadProtobufRoot(dir);
    const second = await loadProtobufRoot(dir);

    // assert
    expect(first.protobufRoot).toBe(second.protobufRoot);
    expect(first.files).toHaveLength(1);
  });

  it('loads a grpc-js package and exposes service ctors', async () => {
    // arrange
    const dir = makeTempDir('grpc-loader');
    writeFixtureProto(dir);

    // act
    const bundle = await loadGrpcPackage(dir);

    // assert
    expect(lookupServiceCtor(bundle.grpcPackage, PROFILE_SERVICE)).toBeTypeOf('function');
  });

  it('throws when no proto files found', async () => {
    await expect(loadProtobufRoot(makeTempDir('proto-empty'))).rejects.toThrow(/no \.proto files/u);
  });

  it('reports unresolved cross-repo imports with the importing file and a fix hint', async () => {
    // arrange
    const dir = makeTempDir('proto-missing-import');
    writeProtoWithMissingCommonImport(dir);

    // act
    const load = loadProtobufRoot(dir);

    // assert
    await expect(load).rejects.toThrow(/unresolved proto import/u);
    await expect(load).rejects.toThrow(/common\.proto/u);
  });

  it('does not flag imports of the bundled google/protobuf files', async () => {
    // arrange
    const dir = makeTempDir('proto-bundled-import');
    writeProtoWithMissingCommonImport(dir);

    // act
    const load = loadProtobufRoot(dir);

    // assert
    await expect(load).rejects.not.toThrow(/timestamp\.proto/u);
  });

  it('resolves cross-module imports across multiple roots', async () => {
    // arrange
    const mainRoot = makeTempDir('proto-root-a');
    const commonRoot = makeTempDir('proto-root-b');
    writeProtoFile(path.join(mainRoot, 'main.proto'), `${PROTO_HEADER}package demo;\nimport "common.proto";\nmessage Req { shared.Common c = 1; }\n`);
    writeProtoFile(path.join(commonRoot, 'common.proto'), `${PROTO_HEADER}package shared;\nmessage Common { string x = 1; }\n`);

    // act
    const bundle = await loadProtobufRoot(`${mainRoot},${commonRoot}`);

    // assert
    expect(bundle.files).toHaveLength(2);
  });

  it('picks up an edited .proto on the next load', async () => {
    // arrange
    const dir = makeTempDir('proto-edit');
    const file = path.join(dir, 'address.proto');
    writeProtoFile(file, `${PROTO_HEADER}package taproot.test;\nmessage Address { string city = 1; }\n`);
    await loadProtobufRoot(dir);
    writeProtoFile(file, `${PROTO_HEADER}package taproot.test;\nmessage Address { string city = 1; string country = 2; }\n`);

    // act
    const { protobufRoot } = await loadProtobufRoot(dir);

    // assert
    expect(fieldNamesOf(protobufRoot, 'taproot.test.Address')).toStrictEqual(['city', 'country']);
  });

  it('loads same-named files from different directories', async () => {
    // arrange
    const dir = makeTempDir('proto-same-name');
    writeProtoFile(path.join(dir, 'a', 'v1', 'types.proto'), `${PROTO_HEADER}package taproot.test.a;\nmessage Address { string city = 1; }\n`);
    writeProtoFile(path.join(dir, 'b', 'v1', 'types.proto'), `${PROTO_HEADER}package taproot.test.b;\nmessage Profile { string name = 1; }\n`);

    // act
    const { files, protobufRoot } = await loadProtobufRoot(dir);

    // assert
    expect(files).toHaveLength(2);
    expect(protobufRoot.lookup('taproot.test.a.Address')).toBeDefined();
    expect(protobufRoot.lookup('taproot.test.b.Profile')).toBeDefined();
  });

  it('loads an import path vendored under two roots once, from the first root', async () => {
    // arrange
    const firstRoot = makeTempDir('proto-vendor-a');
    const secondRoot = makeTempDir('proto-vendor-b');
    writeProtoFile(path.join(firstRoot, 'common', 'address.proto'), `${PROTO_HEADER}package taproot.common;\nmessage Address { string city = 1; }\n`);
    writeProtoFile(path.join(secondRoot, 'common', 'address.proto'), `${PROTO_HEADER}package taproot.common;\nmessage Address { string city = 1; string country = 2; }\n`);

    // act
    const { files, protobufRoot } = await loadProtobufRoot(`${firstRoot},${secondRoot}`);

    // assert
    expect(files).toStrictEqual([path.join(firstRoot, 'common', 'address.proto')]);
    expect(fieldNamesOf(protobufRoot, 'taproot.common.Address')).toStrictEqual(['city']);
  });

  it('fails an import whose path matches no file instead of binding a same-named file', async () => {
    // arrange
    const dir = makeTempDir('proto-same-basename');
    writeProtoFile(path.join(dir, 'a', 'x', 'common.proto'), `${PROTO_HEADER}package taproot.test.x;\nmessage Address { string city = 1; }\n`);
    writeProtoFile(path.join(dir, 'a', 'y', 'common.proto'), `${PROTO_HEADER}package taproot.test.y;\nmessage Address { string city = 1; }\n`);
    writeProtoFile(path.join(dir, 'profile.proto'), `${PROTO_HEADER}package taproot.test;\nimport "z/common.proto";\nmessage Profile { string name = 1; }\n`);

    // act
    const load = loadProtobufRoot(dir);

    // assert
    await expect(load).rejects.toThrow(/unresolved proto import[\s\S]*"z\/common\.proto"/u);
  });

  it('binds an import to the one file whose path ends with the import path', async () => {
    // arrange
    const dir = makeTempDir('proto-import-suffix');
    writeProtoFile(path.join(dir, 'a', 'x', 'common.proto'), `${PROTO_HEADER}package taproot.test.x;\nmessage Address { string city = 1; }\n`);
    writeProtoFile(path.join(dir, 'a', 'y', 'common.proto'), `${PROTO_HEADER}package taproot.test.y;\nmessage Address { string city = 1; }\n`);
    writeProtoFile(path.join(dir, 'profile.proto'), `${PROTO_HEADER}package taproot.test;\nimport "y/common.proto";\nmessage Profile { taproot.test.y.Address address = 1; }\n`);

    // act
    const { protobufRoot } = await loadProtobufRoot(dir);

    // assert
    expect(protobufRoot.lookup('taproot.test.Profile')).toBeDefined();
  });

  it('loads a file once when one root contains another', async () => {
    // arrange
    const dir = makeTempDir('proto-nested-roots');
    writeFixtureProto(path.join(dir, 'profiles'));

    // act
    const { files } = await loadProtobufRoot(`${dir},${path.join(dir, 'profiles')}`);

    // assert
    expect(files).toHaveLength(1);
  });

  it('builds the grpc package from the parsed root without parsing the files again', async () => {
    // arrange
    const dir = makeTempDir('grpc-single-parse');
    writeFixtureProto(dir);
    const loadSync = vi.spyOn(protoLoader, 'loadSync');
    const load = vi.spyOn(protoLoader, 'load');

    // act
    const bundle = await loadGrpcPackage(dir);
    const reloaded = await loadProtobufRoot(dir);

    // assert
    expect(bundle.protobufRoot).toBe(reloaded.protobufRoot);
    expect(loadSync).not.toHaveBeenCalled();
    expect(load).not.toHaveBeenCalled();
    expect(lookupServiceCtor(bundle.grpcPackage, PROFILE_SERVICE)).toBeTypeOf('function');
  });
});
