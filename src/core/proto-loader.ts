import fs from 'node:fs';
import path from 'node:path';
import { str } from './strings.js';

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
  files: string[];
  protobufRoot: ProtobufRoot;
}

export interface GrpcPackageBundle extends LoadedProtoBundle {
  grpcModule: GrpcModule;
  grpcPackage: Record<string, unknown>;
}

export function resolveProtoRoot(flag: string | undefined, resolverHints: Record<string, string> | undefined): string | undefined {
  return str(flag || resolverHints?.protoRoot).trim() || undefined;
}

export function splitProtoRoots(value: string): string[] {
  return str(value)
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

function listAllProtoFiles(roots: string[]): string[] {
  const byImportPath = new Map<string, string>();
  for (const root of roots) {
    for (const file of listProtoFiles(root)) {
      const importPath = path.relative(root, file);
      if (!byImportPath.has(importPath)) byImportPath.set(importPath, file);
    }
  }
  const files = [...new Set(byImportPath.values())];
  if (!files.length) throw new Error(`no .proto files found under '${roots.join(', ')}'`);
  return files;
}

function protoFilesStamp(files: string[]): string {
  return files
    .map((file) => {
      const stat = fs.statSync(file, { throwIfNoEntry: false });
      return `${file}:${stat?.mtimeMs}:${stat?.size}`;
    })
    .join('|');
}

const IMPORT_RE = /^\s*import\s+(?:public\s+|weak\s+)?"([^"]+)"\s*;/gm;

function findImport(target: string, importer: string, roots: string[], files: string[]): string | undefined {
  const direct = [path.dirname(importer), ...roots]
    .map((dir) => path.resolve(dir, target))
    .find((candidate) => fs.existsSync(candidate));
  if (direct) return direct;
  const sameImportPath = files.filter((file) => file.endsWith(`${path.sep}${path.normalize(target)}`));
  return sameImportPath.length === 1 ? sameImportPath[0] : undefined;
}

interface UnresolvedImport {
  importPath: string;
  importedBy: string;
}

function findUnresolvedImports(files: string[], roots: string[]): UnresolvedImport[] {
  const out: UnresolvedImport[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    let content = '';
    try { content = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const match of content.matchAll(IMPORT_RE)) {
      const target = match[1];
      if (target.startsWith('google/protobuf/') || findImport(target, file, roots, files)) continue;
      const key = `${target}|${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ importPath: target, importedBy: file });
    }
  }
  return out;
}

function unresolvedImportsError(unresolved: UnresolvedImport[], roots: string[]): Error {
  const lines = unresolved
    .slice(0, 20)
    .map((u) => `  - "${u.importPath}"  (imported by ${u.importedBy})`);
  const more = unresolved.length > 20 ? `\n  … and ${unresolved.length - 20} more` : '';
  const missing = [...new Set(unresolved.map((u) => path.basename(u.importPath)))].join(', ');
  return new Error(
    `unresolved proto import(s) under proto root(s) [${roots.join(', ')}]:\n${lines.join('\n')}${more}\n` +
      `Missing file(s): ${missing}. These imports live in other proto modules/repos. ` +
      `Clone the repo(s) that provide them and either point --proto-root at the parent directory of your checkouts ` +
      `or add each module dir to --proto-root (comma-separated). google/protobuf/* are bundled and need no checkout.`,
  );
}

async function parseProtoFiles(files: string[], roots: string[]): Promise<LoadedProtoBundle> {
  const unresolved = findUnresolvedImports(files, roots);
  if (unresolved.length) throw unresolvedImportsError(unresolved, roots);
  const mod = await import('protobufjs');
  const ns = ((mod as unknown as { default?: unknown }).default ?? mod) as { Root: new () => unknown };
  const root = new ns.Root() as unknown as ProtobufRoot & {
    resolvePath: (origin: string, target: string) => string;
    load: (files: string[], opts: { keepCase: boolean }) => Promise<unknown>;
  };
  root.resolvePath = (origin: string, target: string): string => findImport(target, origin, roots, files) ?? target;
  await root.load(files, { keepCase: true });
  return { files, protobufRoot: root as unknown as ProtobufRoot };
}

async function buildGrpcPackage(base: LoadedProtoBundle): Promise<GrpcPackageBundle> {
  const grpcMod = await import('@grpc/grpc-js');
  const grpc = ((grpcMod as unknown as { default?: unknown }).default ?? grpcMod) as unknown as GrpcModule;
  const loaderMod = await import('@grpc/proto-loader');
  const protoLoader = ((loaderMod as unknown as { default?: unknown }).default ?? loaderMod) as unknown as {
    fromJSON: (json: unknown, options: Record<string, unknown>) => unknown;
  };
  const protobufJson = (base.protobufRoot as unknown as { toJSON: () => unknown }).toJSON();
  const packageDef = protoLoader.fromJSON(protobufJson, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  return { ...base, grpcModule: grpc, grpcPackage: grpc.loadPackageDefinition(packageDef) };
}

const protobufCache = new Map<string, { stamp: string; bundle: Promise<LoadedProtoBundle> }>();
const grpcCache = new WeakMap<LoadedProtoBundle, Promise<GrpcPackageBundle>>();

export async function loadProtobufRoot(protoRoot: string): Promise<LoadedProtoBundle> {
  const roots = splitProtoRoots(protoRoot).map((root) => path.resolve(root));
  if (!roots.length) throw new Error(`empty proto root: '${protoRoot}'`);
  const key = [...roots].sort().join('|');
  const files = listAllProtoFiles(roots);
  const stamp = protoFilesStamp(files);
  const cached = protobufCache.get(key);
  if (cached?.stamp === stamp) return cached.bundle;
  const entry = { stamp, bundle: parseProtoFiles(files, roots) };
  protobufCache.set(key, entry);
  try {
    return await entry.bundle;
  } catch (err) {
    if (protobufCache.get(key) === entry) protobufCache.delete(key);
    throw err;
  }
}

export async function loadGrpcPackage(protoRoot: string): Promise<GrpcPackageBundle> {
  const base = await loadProtobufRoot(protoRoot);
  let grpcBundle = grpcCache.get(base);
  if (!grpcBundle) {
    grpcBundle = buildGrpcPackage(base);
    grpcCache.set(base, grpcBundle);
  }
  return grpcBundle;
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
}
