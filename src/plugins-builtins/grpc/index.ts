import type {
  DoctorCheck,
  QueryRequest,
  QueryResult,
  RpcServiceShape,
  SchemaContext,
  TapRootPlugin,
} from '../../types/core.js';
import { classifyExecutorDoctorCode } from '../../core/error-classification.js';
import { queryTimeoutError } from '../../core/query-timeout.js';
import { nowIso } from '../../core/time.js';
import {
  loadGrpcPackage,
  lookupServiceCtor,
  type GrpcModule,
} from '../../core/proto-loader.js';
import { describeProto, listServices, resolveName, suggestNames } from '../../core/grpc-introspect.js';
import { validateGrpcRequest } from '../../core/grpc-proto-validate.js';

const CONNECT_TIMEOUT_MS = 5000;

interface GrpcClient extends Record<string, unknown> {
  waitForReady: (deadline: number, callback: (err?: Error) => void) => void;
  close: () => void;
}

const channelCache = new Map<string, GrpcClient>();

function channelKey(ds: QueryRequest['datasource'], creds: Record<string, string>): string {
  return [
    ds.connection.host || '127.0.0.1',
    ds.connection.port || 6565,
    ds.connection.ssl ? 'tls' : 'h2c',
    ds.resolverHints?.protoRoot || '',
    creds.token || '',
  ].join('|');
}

function buildClient(
  grpc: GrpcModule,
  ServiceCtor: new (t: string, c: unknown) => Record<string, unknown>,
  ds: QueryRequest['datasource'],
): GrpcClient {
  const target = `${ds.connection.host || '127.0.0.1'}:${ds.connection.port || 6565}`;
  const creds = ds.connection.ssl ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
  return new ServiceCtor(target, creds) as GrpcClient;
}

function getOrCreateClient(
  grpc: GrpcModule,
  ServiceCtor: new (t: string, c: unknown) => Record<string, unknown>,
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
    const fn = client[method];
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

function schemaContextFor(
  descriptor: ReturnType<typeof describeProto>,
  serviceName: string,
): SchemaContext {
  const services: Record<string, RpcServiceShape> = {};
  for (const svc of descriptor.services) {
    if (svc.name === serviceName) services[svc.name] = svc;
  }
  return {
    tables: {},
    services,
    messages: descriptor.messages,
    enums: descriptor.enums,
  };
}

export const grpcPlugin: TapRootPlugin = {
  manifest: {
    name: 'grpc',
    version: '0.2.0',
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
      const { grpc, pkg, protobufRoot } = await loadGrpcPackage(protoRoot).then((b) => ({
        grpc: b.grpcModule,
        pkg: b.grpcPackage,
        protobufRoot: b.protobufRoot,
      }));
      const probe = hints.probeService || listServices(protobufRoot)[0]?.name;
      if (!probe) {
        return [{ check: 'grpc proto load', status: 'warn', detail: `loaded proto root ${protoRoot} but no service found to probe`, code: 'executor_configuration_missing' }];
      }
      const ServiceCtor = lookupServiceCtor(pkg, probe);
      const client = buildClient(grpc, ServiceCtor, ds);
      try {
        await new Promise<void>((resolve, reject) => {
          client.waitForReady(Date.now() + CONNECT_TIMEOUT_MS, (err) => (err ? reject(err) : resolve()));
        });
        return [{ check: 'grpc channel', status: 'ok', detail: `connected to ${ds.connection.host}:${ds.connection.port} (${probe})` }];
      } finally {
        client.close();
      }
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
    const bundle = await loadGrpcPackage(protoRoot);
    const services = listServices(bundle.protobufRoot);
    const svcShape = services.find((s) => s.name === service);
    if (!svcShape) {
      const res = resolveName(service, services.map((s) => s.name));
      const hint = res.match
        ? ` Did you mean '${res.match}'?`
        : res.candidates.length
          ? ` Closest: ${res.candidates.slice(0, 5).join(', ')}.`
          : '';
      throw new Error(`grpc service '${service}' not found in proto root.${hint} Run 'taproot grpc list' to see services.`);
    }
    const methodNames = svcShape.methods.map((m) => m.name);
    let canonicalMethod = methodNames.find((m) => m === method);
    if (!canonicalMethod) {
      const ci = methodNames.filter((m) => m.toLowerCase() === method.toLowerCase());
      if (ci.length === 1) {
        canonicalMethod = ci[0];
      } else {
        const close = suggestNames(method, methodNames, 3);
        const hint = close.length ? ` Did you mean ${close.map((m) => `'${m}'`).join(', ')}?` : '';
        throw new Error(`grpc method '${method}' not found on ${service}.${hint} Available: ${methodNames.join(', ')}.`);
      }
    }
    const skipProtoValidate = pp.skipProtoValidate === true || pp.skipProtoValidate === 'true';
    if (!skipProtoValidate) {
      const methodShape = svcShape.methods.find((m) => m.name === canonicalMethod);
      if (methodShape) {
        const validationError = validateGrpcRequest(bundle.protobufRoot, methodShape.requestType, payload);
        if (validationError) {
          const err = new Error(`BAD_INPUT: ${validationError.message}`);
          (err as Error & { code?: string; details?: Record<string, unknown> }).code = 'BAD_INPUT';
          (err as Error & { code?: string; details?: Record<string, unknown> }).details = {
            field: validationError.field,
            expected: validationError.expected,
            nextCommand: `taproot grpc describe --datasource ${request.datasource.name} --method ${canonicalMethod} --skeleton`,
          };
          throw err;
        }
      }
    }
    const ServiceCtor = lookupServiceCtor(bundle.grpcPackage, service);
    const client = getOrCreateClient(bundle.grpcModule, ServiceCtor, request.datasource, creds, service);
    let metadata: { add: (k: string, v: string) => void } | undefined;
    if (creds.token) {
      metadata = new bundle.grpcModule.Metadata();
      metadata.add('authorization', `Bearer ${creds.token}`);
    }
    const metaHints = Object.entries((request.datasource.resolverHints || {}) as Record<string, string>)
      .filter(([k]) => k.startsWith('metadata.'))
      .map(([k, v]) => [k.slice('metadata.'.length), v] as const);
    if (metaHints.length) {
      if (!metadata) metadata = new bundle.grpcModule.Metadata();
      for (const [k, v] of metaHints) metadata.add(k, v);
    }
    const deadlineMs = request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : 5000;
    let response: Record<string, unknown>;
    try {
      response = await Promise.race([
        callUnary(client, canonicalMethod, payload, metadata, deadlineMs),
        new Promise<never>((_, reject) => setTimeout(() => reject(queryTimeoutError(deadlineMs)), deadlineMs + 500)),
      ]);
    } catch (err) {
      const msg = (err as Error).message || String(err);
      if (/deadline exceeded/i.test(msg)) throw queryTimeoutError(deadlineMs);
      throw err;
    }
    let schemaContext: SchemaContext | undefined;
    try {
      const descriptor = describeProto(bundle.protobufRoot, { service, method: canonicalMethod });
      schemaContext = schemaContextFor(descriptor, service);
    } catch {
      schemaContext = undefined;
    }
    const result: QueryResult = {
      runId: '',
      datasource: request.datasource.name,
      plugin: 'grpc',
      capability: request.capability,
      query: { native: `${service}/${canonicalMethod}` },
      result: { columns: ['value'], rows: [{ value: response }] },
      timings: {
        startedAt,
        endedAt: nowIso(),
        durationMs: Date.now() - start,
      },
      warnings: [],
      classification: 'success',
    };
    if (schemaContext) result.meta = { schemaContext };
    return result;
  },
};
