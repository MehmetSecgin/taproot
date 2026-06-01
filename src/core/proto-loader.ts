import fs from 'node:fs';
import path from 'node:path';

export interface ProtobufType {
  decode: (buf: Uint8Array) => unknown;
  toObject: (msg: unknown, opts: Record<string, unknown>) => Record<string, unknown>;
}

export interface ProtobufRoot {
  lookupType(name: string): ProtobufType;
  lookup(name: string): unknown;
  nestedArray: unknown[];
}

export interface GrpcModule {
  credentials: { createInsecure: () => unknown; createSsl: () => unknown };
  loadPackageDefinition: (pkg: unknown) => Record<string, unknown>;
  Metadata: new () => { add: (k: string, v: string) => void };
  status: Record<string, number>;
}

export interface LoadedProtoBundle {
  roots: string[];
  files: string[];
  includeDirs: string[];
  protobufRoot: ProtobufRoot;
}

export interface GrpcPackageBundle extends LoadedProtoBundle {
  grpcModule: GrpcModule;
  grpcPackage: Record<string, unknown>;
}

export function splitProtoRoots(value: string): string[] {
  return String(value || '')
    .split(/[,;:]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

function listProtoFiles(rootDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        if (entry.name === 'google') continue;
        walk(abs);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith('.proto')) files.push(abs);
    }
  };
  walk(rootDir);
  return files;
}

function collectAndDedupe(roots: string[]): { files: string[]; includeDirs: string[] } {
  const all: string[] = [];
  for (const r of roots) all.push(...listProtoFiles(r));
  if (!all.length) throw new Error(`no .proto files found under '${roots.join(', ')}'`);
  const seen = new Map<string, string>();
  for (const f of all) {
    const base = path.basename(f);
    if (!seen.has(base)) seen.set(base, f);
  }
  const files = [...seen.values()];
  const includeDirs = [...new Set([...roots, ...files.map((f) => path.dirname(f))])];
  return { files, includeDirs };
}

function normalizeCacheKey(roots: string[]): string {
  return roots.map((r) => path.resolve(r)).sort().join('|');
}

const protobufCache = new Map<string, Promise<LoadedProtoBundle>>();
const grpcCache = new Map<string, Promise<GrpcPackageBundle>>();

export async function loadProtobufRoot(protoRoot: string): Promise<LoadedProtoBundle> {
  const roots = splitProtoRoots(protoRoot);
  if (!roots.length) throw new Error(`empty proto root: '${protoRoot}'`);
  const key = normalizeCacheKey(roots);
  const cached = protobufCache.get(key);
  if (cached) return cached;
  const promise = (async (): Promise<LoadedProtoBundle> => {
    const { files, includeDirs } = collectAndDedupe(roots);
    const mod = await import('protobufjs');
    const ns = ((mod as unknown as { default?: unknown }).default ?? mod) as { Root: new () => unknown };
    const root = new ns.Root() as unknown as ProtobufRoot & {
      resolvePath: (origin: string, target: string) => string;
      load: (files: string[], opts: { keepCase: boolean }) => Promise<unknown>;
    };
    root.resolvePath = (origin: string, target: string): string => {
      if (path.isAbsolute(target) && fs.existsSync(target)) return target;
      if (origin) {
        const rel = path.resolve(path.dirname(origin), target);
        if (fs.existsSync(rel)) return rel;
      }
      for (const r of roots) {
        const absUnder = path.resolve(r, target);
        if (fs.existsSync(absUnder)) return absUnder;
      }
      const byBasename = files.find((f) => path.basename(f) === path.basename(target));
      if (byBasename) return byBasename;
      return target;
    };
    await root.load(files, { keepCase: true });
    return { roots, files, includeDirs, protobufRoot: root as unknown as ProtobufRoot };
  })();
  protobufCache.set(key, promise);
  try {
    return await promise;
  } catch (err) {
    protobufCache.delete(key);
    throw err;
  }
}

export async function loadGrpcPackage(protoRoot: string): Promise<GrpcPackageBundle> {
  const roots = splitProtoRoots(protoRoot);
  if (!roots.length) throw new Error(`empty proto root: '${protoRoot}'`);
  const key = normalizeCacheKey(roots);
  const cached = grpcCache.get(key);
  if (cached) return cached;
  const promise = (async (): Promise<GrpcPackageBundle> => {
    const base = await loadProtobufRoot(protoRoot);
    const grpcMod = await import('@grpc/grpc-js');
    const grpc = ((grpcMod as unknown as { default?: unknown }).default ?? grpcMod) as unknown as GrpcModule;
    const loaderMod = await import('@grpc/proto-loader');
    const protoLoader = ((loaderMod as unknown as { default?: unknown }).default ?? loaderMod) as unknown as {
      loadSync: (files: string[] | string, options: Record<string, unknown>) => unknown;
    };
    const packageDef = protoLoader.loadSync(base.files, {
      keepCase: true,
      longs: String,
      enums: String,
      defaults: true,
      oneofs: true,
      includeDirs: base.includeDirs,
    });
    const pkg = grpc.loadPackageDefinition(packageDef);
    return { ...base, grpcModule: grpc, grpcPackage: pkg };
  })();
  grpcCache.set(key, promise);
  try {
    return await promise;
  } catch (err) {
    grpcCache.delete(key);
    throw err;
  }
}

export function lookupServiceCtor(
  pkg: Record<string, unknown>,
  fullyQualified: string,
): new (target: string, creds: unknown) => Record<string, unknown> {
  const parts = fullyQualified.split('.');
  let node: unknown = pkg;
  for (const part of parts) {
    if (!node || typeof node !== 'object') {
      throw new Error(`unknown grpc service path '${fullyQualified}' (failed at '${part}')`);
    }
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== 'function') {
    throw new Error(`'${fullyQualified}' did not resolve to a grpc service constructor; check the package + service name match the .proto`);
  }
  return node as new (t: string, c: unknown) => Record<string, unknown>;
}

export function _resetProtoCachesForTest(): void {
  protobufCache.clear();
  grpcCache.clear();
}
