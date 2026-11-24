import path from 'node:path';
import { assertImportsResolve, findImport, listAllProtoFiles, protoFilesStamp } from './proto-files.js';
import { isRecord } from './json-shapes.js';
import { textUnlessFalsy } from './text-presence.js';

const PROTO_ROOT_SEPARATORS = /[,;:]/u;

type ProtobufType = {
  decode: (buffer: Uint8Array) => unknown;
  toObject: (message: unknown, options: Record<string, unknown>) => Record<string, unknown>;
};

export type ProtobufRoot = {
  lookupType: (name: string) => ProtobufType;
  lookup: (name: string) => unknown;
  nestedArray: unknown[];
  toJSON: () => unknown;
};

export type GrpcModule = {
  credentials: { createInsecure: () => unknown; createSsl: () => unknown };
  loadPackageDefinition: (pkg: unknown) => Record<string, unknown>;
  Metadata: new () => { add: (key: string, value: string) => void };
  status: Record<string, number>;
};

type LoadableProtobufRoot = ProtobufRoot & {
  resolvePath: (origin: string, target: string) => string;
  load: (files: string[], options: { keepCase: boolean }) => Promise<unknown>;
};

type ProtobufNamespace = {
  Root: new () => unknown;
};

type ProtoPackageLoader = {
  fromJSON: (json: unknown, options: Record<string, unknown>) => unknown;
};

type ProtobufBundle = {
  files: string[];
  protobufRoot: ProtobufRoot;
};

export type GrpcBundle = ProtobufBundle & {
  grpcModule: GrpcModule;
  grpcPackage: Record<string, unknown>;
};

type ServiceConstructor = new (target: string, credentials: unknown) => Record<string, unknown>;

type ProtoLoadRequest = {
  cacheKey: string;
  stamp: string;
  files: string[];
  roots: string[];
};

const protobufCache = new Map<string, { stamp: string; bundle: Promise<ProtobufBundle> }>();
const grpcCache = new WeakMap<ProtobufBundle, Promise<GrpcBundle>>();

function hasFunction(value: Record<string, unknown>, name: string): boolean {
  return typeof value[name] === 'function';
}

function isProtobufNamespace(value: unknown): value is ProtobufNamespace {
  return isRecord(value) && hasFunction(value, 'Root');
}

function isLoadableProtobufRoot(value: unknown): value is LoadableProtobufRoot {
  return isRecord(value) && hasFunction(value, 'load') && hasFunction(value, 'lookupType') && hasFunction(value, 'toJSON');
}

function isGrpcModule(value: unknown): value is GrpcModule {
  return isRecord(value) && hasFunction(value, 'loadPackageDefinition') && hasFunction(value, 'Metadata') && isRecord(value.credentials);
}

function isProtoPackageLoader(value: unknown): value is ProtoPackageLoader {
  return isRecord(value) && hasFunction(value, 'fromJSON');
}

function isServiceConstructor(value: unknown): value is ServiceConstructor {
  return typeof value === 'function';
}

function unwrapDefaultExport(importedModule: object): unknown {
  const defaultExport: unknown = 'default' in importedModule ? importedModule.default : undefined;
  return defaultExport ?? importedModule;
}

function unexpectedModuleShape(moduleName: string): Error {
  return new TypeError(`${moduleName} did not load the expected API`);
}

export function resolveProtoRoot(flag: string | undefined, resolverHints: Record<string, string> | undefined): string | undefined {
  const chosen = flag === undefined || flag === '' ? resolverHints?.protoRoot : flag;
  const trimmed = textUnlessFalsy(chosen).trim();
  return trimmed === '' ? undefined : trimmed;
}

function splitProtoRoots(value: string): string[] {
  return textUnlessFalsy(value)
    .split(PROTO_ROOT_SEPARATORS)
    .map((root) => root.trim())
    .filter((root) => root !== '');
}

async function parseProtoFiles(files: string[], roots: string[]): Promise<ProtobufBundle> {
  assertImportsResolve(files, roots);
  const namespace = unwrapDefaultExport(await import('protobufjs'));
  if (!isProtobufNamespace(namespace)) {
    throw unexpectedModuleShape('protobufjs');
  }
  const root = new namespace.Root();
  if (!isLoadableProtobufRoot(root)) {
    throw unexpectedModuleShape('protobufjs');
  }
  root.resolvePath = (origin: string, target: string): string => findImport(target, { importer: origin, roots, files }) ?? target;
  await root.load(files, { keepCase: true });
  return { files, protobufRoot: root };
}

async function buildGrpcPackage(base: ProtobufBundle): Promise<GrpcBundle> {
  const grpcModule = unwrapDefaultExport(await import('@grpc/grpc-js'));
  const packageLoader = unwrapDefaultExport(await import('@grpc/proto-loader'));
  if (!isGrpcModule(grpcModule)) {
    throw unexpectedModuleShape('@grpc/grpc-js');
  }
  if (!isProtoPackageLoader(packageLoader)) {
    throw unexpectedModuleShape('@grpc/proto-loader');
  }
  const packageDefinition = packageLoader.fromJSON(base.protobufRoot.toJSON(), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  return { ...base, grpcModule, grpcPackage: grpcModule.loadPackageDefinition(packageDefinition) };
}

async function parseProtoFilesCached({ cacheKey, stamp, files, roots }: ProtoLoadRequest): Promise<ProtobufBundle> {
  const cached = protobufCache.get(cacheKey);
  if (cached?.stamp === stamp) {
    return cached.bundle;
  }
  const entry = { stamp, bundle: parseProtoFiles(files, roots) };
  protobufCache.set(cacheKey, entry);
  try {
    return await entry.bundle;
  } catch (error) {
    if (protobufCache.get(cacheKey) === entry) {
      protobufCache.delete(cacheKey);
    }
    throw error;
  }
}

export async function loadProtobufRoot(protoRoot: string): Promise<ProtobufBundle> {
  const roots = splitProtoRoots(protoRoot).map((root) => path.resolve(root));
  if (roots.length === 0) {
    throw new Error(`empty proto root: '${protoRoot}'`);
  }
  const files = listAllProtoFiles(roots);
  return parseProtoFilesCached({ cacheKey: roots.toSorted().join('|'), stamp: protoFilesStamp(files), files, roots });
}

export async function loadGrpcPackage(protoRoot: string): Promise<GrpcBundle> {
  const base = await loadProtobufRoot(protoRoot);
  const cachedBundle = grpcCache.get(base);
  if (cachedBundle !== undefined) {
    return cachedBundle;
  }
  const grpcBundle = buildGrpcPackage(base);
  grpcCache.set(base, grpcBundle);
  return grpcBundle;
}

export function lookupServiceCtor(grpcPackage: Record<string, unknown>, fullyQualified: string): ServiceConstructor {
  let node: unknown = grpcPackage;
  for (const part of fullyQualified.split('.')) {
    if (!isRecord(node)) {
      throw new Error(`unknown grpc service path '${fullyQualified}' (failed at '${part}')`);
    }
    node = Reflect.get(node, part);
  }
  if (!isServiceConstructor(node)) {
    throw new TypeError(`'${fullyQualified}' did not resolve to a grpc service constructor; check the package + service name match the .proto`);
  }
  return node;
}

export function resetProtoCacheForTest(): void {
  protobufCache.clear();
}
