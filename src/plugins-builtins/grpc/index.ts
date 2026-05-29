import fs from 'node:fs';
import path from 'node:path';
import type { DoctorCheck, QueryRequest, QueryResult, TapRootPlugin } from '../../types/core.js';
import { classifyExecutorDoctorCode } from '../../core/error-classification.js';
import { queryTimeoutError } from '../../core/query-timeout.js';
import { nowIso } from '../../core/time.js';

const CONNECT_TIMEOUT_MS = 5000;

interface GrpcClient {
  waitForReady: (deadline: number, callback: (err?: Error) => void) => void;
  close: () => void;
  [methodName: string]: unknown;
}

interface GrpcModule {
  credentials: {
    createInsecure: () => unknown;
    createSsl: () => unknown;
  };
  loadPackageDefinition: (pkg: unknown) => Record<string, unknown>;
  Metadata: new () => { add: (k: string, v: string) => void };
  status: Record<string, number>;
}

interface ProtoLoaderModule {
  loadSync: (
    files: string[] | string,
    options: { keepCase?: boolean; longs?: unknown; enums?: unknown; defaults?: boolean; oneofs?: boolean; includeDirs?: string[] },
  ) => unknown;
}

const packageCache = new Map<string, Record<string, unknown>>();
const channelCache = new Map<string, GrpcClient>();

function listProtoFiles(rootDir: string): string[] {
  const files: string[] = [];
  const walk = (dir: string): void => {
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        // Skip vendored google/protobuf well-known types — proto-loader ships its own copy
        // and gradle bundles ship duplicates, which collide with "duplicate name 'Option'".
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

function splitProtoRoots(value: string): string[] {
  return value
    .split(/[,;:]/)
    .map((p) => p.trim())
    .filter(Boolean);
}

async function loadGrpcAndPackage(protoRoot: string): Promise<{ grpc: GrpcModule; pkg: Record<string, unknown> }> {
  const grpcMod = await import('@grpc/grpc-js');
  const grpc = ((grpcMod as unknown as { default?: unknown }).default ?? grpcMod) as unknown as GrpcModule;
  // Cache by the normalized list so the same set of roots resolves once regardless of separator/order.
  const roots = splitProtoRoots(protoRoot);
  const cacheKey = [...roots].sort().join('|');
  const cached = packageCache.get(cacheKey);
  if (cached) return { grpc, pkg: cached };
  const loaderMod = await import('@grpc/proto-loader');
  const protoLoader = ((loaderMod as unknown as { default?: unknown }).default ?? loaderMod) as unknown as ProtoLoaderModule;
  const allFiles: string[] = [];
  for (const root of roots) {
    const files = listProtoFiles(root);
    allFiles.push(...files);
  }
  if (!allFiles.length) throw new Error(`no .proto files found under '${protoRoot}'`);
  // Drop duplicates by basename (gradle bundles repeat common.proto / feed_common.proto across
  // sibling repos and proto-loader chokes on duplicate symbol registration).
  const seen = new Map<string, string>();
  for (const f of allFiles) {
    const base = path.basename(f);
    if (!seen.has(base)) seen.set(base, f);
  }
  const dedupedFiles = Array.from(seen.values());
  const includeDirs = Array.from(new Set([...roots, ...dedupedFiles.map((f) => path.dirname(f))]));
  const packageDef = protoLoader.loadSync(dedupedFiles, {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
    includeDirs,
  });
  const pkg = grpc.loadPackageDefinition(packageDef);
  packageCache.set(cacheKey, pkg);
  return { grpc, pkg };
}

function lookupServiceCtor(pkg: Record<string, unknown>, fullyQualified: string): new (target: string, creds: unknown) => GrpcClient {
  const parts = fullyQualified.split('.');
  let node: unknown = pkg;
  for (const part of parts) {
    if (!node || typeof node !== 'object') throw new Error(`unknown grpc service path '${fullyQualified}' (failed at '${part}')`);
    node = (node as Record<string, unknown>)[part];
  }
  if (typeof node !== 'function') {
    throw new Error(`'${fullyQualified}' did not resolve to a grpc service constructor; check the package + service name match the .proto`);
  }
  return node as new (target: string, creds: unknown) => GrpcClient;
}

function channelKey(ds: QueryRequest['datasource'], creds: Record<string, string>): string {
  return [
    ds.connection.host || '127.0.0.1',
    ds.connection.port || 6565,
    ds.connection.ssl ? 'tls' : 'h2c',
    ds.resolverHints?.protoRoot || '',
    creds.token || '',
  ].join('|');
}

function buildClient(grpc: GrpcModule, ServiceCtor: new (t: string, c: unknown) => GrpcClient, ds: QueryRequest['datasource']): GrpcClient {
  const target = `${ds.connection.host || '127.0.0.1'}:${ds.connection.port || 6565}`;
  const creds = ds.connection.ssl ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
  return new ServiceCtor(target, creds);
}

function getOrCreateClient(
  grpc: GrpcModule,
  ServiceCtor: new (t: string, c: unknown) => GrpcClient,
  ds: QueryRequest['datasource'],
  creds: Record<string, string>,
  serviceName: string,
): GrpcClient {
  const key = `${channelKey(ds, creds)}|${serviceName}`;
  const existing = channelCache.get(key);
  if (existing) return existing;
  const client = buildClient(grpc, ServiceCtor, ds);
  channelCache.set(key, client);
  return client;
}

interface ParsedQuery { service: string; method: string }

function parseQuery(input: string): ParsedQuery {
  const text = String(input || '').trim();
  if (!text) throw new Error('empty grpc query; expected "<package.Service/Method>"');
  const slash = text.indexOf('/');
  if (slash <= 0 || slash === text.length - 1) {
    throw new Error(`grpc query '${text}' missing '/' separator. Expected "<package.Service/Method>" e.g. "com.example.catalog.v1.CatalogService/getItems"`);
  }
  return { service: text.slice(0, slash), method: text.slice(slash + 1) };
}

function resolveProtoRoot(request: QueryRequest): string {
  const pp = (request.pluginParams || {}) as Record<string, unknown>;
  const hints = (request.datasource.resolverHints || {}) as Record<string, string>;
  const root = String(pp.protoRoot || hints.protoRoot || '').trim();
  if (!root) {
    throw new Error("grpc plugin needs a proto root. Pass --proto-root <dir> or set resolverHints.protoRoot on the datasource.");
  }
  return root;
}

function resolveRequestPayload(request: QueryRequest, paramPairs: Record<string, string>): Record<string, unknown> {
  const pp = (request.pluginParams || {}) as Record<string, unknown>;
  const raw = pp.requestJson;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('request JSON must decode to a non-array object');
      }
      return parsed as Record<string, unknown>;
    } catch (err) {
      throw new Error(`invalid --request-json: ${(err as Error).message}`);
    }
  }
  // Fallback: --param key=value pairs. Numeric-looking values are coerced to numbers
  // so int32/int64 fields don't need quoting; everything else stays string.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(paramPairs)) {
    if (/^-?\d+$/.test(v)) out[k] = Number(v);
    else if (/^-?\d+\.\d+$/.test(v)) out[k] = Number(v);
    else if (v === 'true' || v === 'false') out[k] = v === 'true';
    else out[k] = v;
  }
  return out;
}

function callUnary(
  client: GrpcClient,
  method: string,
  payload: Record<string, unknown>,
  metadata: { add: (k: string, v: string) => void } | undefined,
  deadlineMs: number,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const fn = (client as Record<string, unknown>)[method];
    if (typeof fn !== 'function') {
      reject(new Error(`grpc method '${method}' not found on service. Check spelling and that the .proto defines it.`));
      return;
    }
    type GrpcCallback = (err: (Error & { code?: number; details?: string }) | null, response: Record<string, unknown>) => void;
    const cb: GrpcCallback = (err, response) => {
      if (err) {
        const msg = err.details || err.message || 'grpc call failed';
        const code = typeof err.code === 'number' ? `grpc_code=${err.code} ` : '';
        reject(new Error(`${code}${msg}`));
        return;
      }
      resolve(response || {});
    };
    const options = { deadline: Date.now() + Math.max(1, deadlineMs) };
    if (metadata) {
      (fn as (req: unknown, md: unknown, opts: unknown, cb: GrpcCallback) => void).call(client, payload, metadata, options, cb);
    } else {
      (fn as (req: unknown, opts: unknown, cb: GrpcCallback) => void).call(client, payload, options, cb);
    }
  });
}

export const grpcPlugin: TapRootPlugin = {
  manifest: {
    name: 'grpc',
    version: '0.1.0',
    kind: 'executor',
    capabilities: ['doctor', 'executeRead'],
    accessMethods: ['native', 'qa-portforward'],
    priority: 100,
  },

  async doctor(input): Promise<DoctorCheck[]> {
    const ds = input.datasource;
    const hints = (ds.resolverHints || {}) as Record<string, string>;
    const protoRoot = hints.protoRoot;
    if (!protoRoot) {
      return [{ check: 'grpc proto-root', status: 'warn', detail: "no resolverHints.protoRoot configured; doctor can only open a channel, not exercise a real method.", code: 'executor_configuration_missing' }];
    }
    try {
      const { grpc, pkg } = await loadGrpcAndPackage(protoRoot);
      const probeServiceName = hints.probeService;
      if (probeServiceName) {
        const ServiceCtor = lookupServiceCtor(pkg, probeServiceName);
        const client = buildClient(grpc, ServiceCtor, ds);
        try {
          await new Promise<void>((resolve, reject) => {
            client.waitForReady(Date.now() + CONNECT_TIMEOUT_MS, (err) => (err ? reject(err) : resolve()));
          });
          return [{ check: 'grpc channel', status: 'ok', detail: `connected to ${ds.connection.host}:${ds.connection.port} (${probeServiceName})` }];
        } finally {
          client.close();
        }
      }
      return [{ check: 'grpc proto load', status: 'ok', detail: `loaded proto root ${protoRoot}` }];
    } catch (err) {
      const detail = (err as Error).message || 'unknown grpc doctor error';
      return [{ check: 'grpc channel', status: 'fail', detail, code: classifyExecutorDoctorCode(detail) }];
    }
  },

  async execute(request, creds): Promise<QueryResult> {
    const startedAt = nowIso();
    const start = Date.now();
    const { service, method } = parseQuery(request.query);
    const protoRoot = resolveProtoRoot(request);
    const pp = (request.pluginParams || {}) as Record<string, unknown>;
    const paramPairs = (pp.params as Record<string, string>) || {};
    const payload = resolveRequestPayload(request, paramPairs);
    const { grpc, pkg } = await loadGrpcAndPackage(protoRoot);
    const ServiceCtor = lookupServiceCtor(pkg, service);
    const client = getOrCreateClient(grpc, ServiceCtor, request.datasource, creds, service);
    let metadata: { add: (k: string, v: string) => void } | undefined;
    if (creds.token) {
      metadata = new grpc.Metadata();
      metadata.add('authorization', `Bearer ${creds.token}`);
    }
    const metaHints = Object.entries((request.datasource.resolverHints || {}) as Record<string, string>)
      .filter(([k]) => k.startsWith('metadata.'))
      .map(([k, v]) => [k.slice('metadata.'.length), v] as const);
    if (metaHints.length) {
      if (!metadata) metadata = new grpc.Metadata();
      for (const [k, v] of metaHints) metadata.add(k, v);
    }
    const deadlineMs = request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : 5000;
    let response: Record<string, unknown>;
    try {
      response = await Promise.race([
        callUnary(client, method, payload, metadata, deadlineMs),
        new Promise<never>((_, reject) => setTimeout(() => reject(queryTimeoutError(deadlineMs)), deadlineMs + 500)),
      ]);
    } catch (err) {
      const msg = (err as Error).message || String(err);
      if (/deadline exceeded/i.test(msg)) throw queryTimeoutError(deadlineMs);
      throw err;
    }
    return {
      runId: '',
      datasource: request.datasource.name,
      plugin: 'grpc',
      capability: request.capability,
      query: { native: `${service}/${method}` },
      result: { columns: ['value'], rows: [{ value: response }] },
      timings: {
        startedAt,
        endedAt: nowIso(),
        durationMs: Date.now() - start,
      },
      warnings: [],
      classification: 'success',
    };
  },
};
