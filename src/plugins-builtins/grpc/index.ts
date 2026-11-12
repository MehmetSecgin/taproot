import { str } from '../../core/strings.js';
import type {
  DoctorCheck,
  QueryRequest,
  QueryResult,
  RpcMethodShape,
  RpcServiceShape,
  TapRootPlugin,
} from '../../types/core.js';
import { DoctorStatus } from '../../types/core.js';
import { badInput, classifyExecutorDoctorCode } from '../../core/error-classification.js';
import { queryTimeoutError } from '../../core/query-timeout.js';
import { nowIso } from '../../core/time.js';
import {
  loadGrpcPackage,
  lookupServiceCtor,
  resolveProtoRoot,
  type GrpcModule,
} from '../../core/proto-loader.js';
import { listServices, matchName, resolveName } from '../../core/grpc-introspect.js';
import { validateGrpcRequest } from '../../core/grpc-proto-validate.js';
import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { callStreaming, callUnary, isStreamingMethod } from './call.js';

interface GrpcClient extends Record<string, unknown> {
  waitForReady: (deadline: number, callback: (err?: Error) => void) => void;
  close: () => void;
}

type ServiceConstructor = new (t: string, c: unknown) => Record<string, unknown>;

type Metadata = InstanceType<GrpcModule['Metadata']>;

const clientCache = new Map<string, { ServiceCtor: ServiceConstructor; client: GrpcClient }>();

function clientTarget(ds: QueryRequest['datasource']): string {
  return `${ds.connection.host || '127.0.0.1'}:${ds.connection.port || RUNTIME_CONSTANTS.defaultPorts.grpc}`;
}

function buildClient(grpc: GrpcModule, ServiceCtor: ServiceConstructor, ds: QueryRequest['datasource']): GrpcClient {
  const creds = ds.connection.ssl ? grpc.credentials.createSsl() : grpc.credentials.createInsecure();
  return new ServiceCtor(clientTarget(ds), creds) as GrpcClient;
}

function getOrCreateClient(
  grpc: GrpcModule,
  ServiceCtor: ServiceConstructor,
  ds: QueryRequest['datasource'],
  protoRoot: string,
  serviceName: string,
): GrpcClient {
  const key = [clientTarget(ds), ds.connection.ssl ? 'tls' : 'h2c', protoRoot, serviceName].join('|');
  const cached = clientCache.get(key);
  if (cached?.ServiceCtor === ServiceCtor) return cached.client;
  cached?.client.close();
  const client = buildClient(grpc, ServiceCtor, ds);
  clientCache.set(key, { ServiceCtor, client });
  return client;
}

interface ParsedQuery { service: string; method: string }

function parseQuery(input: string): ParsedQuery {
  const text = str(input).trim();
  if (!text) throw new Error('empty grpc query; expected "<package.Service/Method>"');
  const slash = text.indexOf('/');
  if (slash <= 0 || slash === text.length - 1) {
    throw new Error(`grpc query '${text}' missing '/' separator. Expected "<package.Service/Method>" e.g. "com.example.catalog.v1.CatalogService/getItems"`);
  }
  return { service: text.slice(0, slash), method: text.slice(slash + 1) };
}

function nameHint(query: string, names: string[]): string {
  const near = resolveName(query, names);
  if (near.match) return ` Did you mean '${near.match}'?`;
  return near.candidates.length ? ` Closest: ${near.candidates.slice(0, 5).join(', ')}.` : '';
}

function resolveMethod(services: RpcServiceShape[], query: ParsedQuery): { service: string; method: RpcMethodShape } {
  const serviceNames = services.map((s) => s.name);
  const service = matchName(query.service, serviceNames);
  if (!service) {
    throw new Error(`grpc service '${query.service}' not found in proto root.${nameHint(query.service, serviceNames)} Run 'taproot grpc list' to see services.`);
  }
  const methods = services.find((s) => s.name === service)!.methods;
  const methodNames = methods.map((m) => m.name);
  const methodName = matchName(query.method, methodNames);
  if (!methodName) {
    throw new Error(`grpc method '${query.method}' not found on ${service}.${nameHint(query.method, methodNames)} Available: ${methodNames.join(', ')}.`);
  }
  return { service, method: methods.find((m) => m.name === methodName)! };
}

function resolveRequestPayload(request: QueryRequest, paramPairs: Record<string, string>): Record<string, unknown> | unknown[] {
  const pp = request.pluginParams || {};
  const raw = pp.requestJson;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (parsed === null || typeof parsed !== 'object') {
        throw new Error('request JSON must decode to an object, or an array of objects for a client-streaming or bidi method');
      }
      return parsed as Record<string, unknown> | unknown[];
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

function requestMessages(
  payload: Record<string, unknown> | unknown[],
  service: string,
  method: RpcMethodShape,
): Record<string, unknown>[] {
  if (!Array.isArray(payload)) return [payload];
  if (!method.requestStream) {
    throw badInput(`${service}/${method.name} takes one request message, not an array. Pass a JSON object in --request-json.`);
  }
  const limit = RUNTIME_CONSTANTS.grpc.streamMessageLimit;
  if (payload.length > limit) {
    throw badInput(`stream request has ${payload.length} messages; the limit is ${limit} per call. Split the batch or raise TAPROOT_GRPC_STREAM_MESSAGE_LIMIT.`);
  }
  payload.forEach((message, index) => {
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      throw badInput(`request[${index}] must be a JSON object`, { field: `[${index}]`, expected: 'object' });
    }
  });
  return payload as Record<string, unknown>[];
}

function callMetadata(grpc: GrpcModule, creds: Record<string, string>, ds: QueryRequest['datasource']): Metadata {
  const metadata = new grpc.Metadata();
  if (creds.token) metadata.add('authorization', `Bearer ${creds.token}`);
  for (const [key, value] of Object.entries(ds.resolverHints || {})) {
    if (key.startsWith('metadata.')) metadata.add(key.slice('metadata.'.length), value);
  }
  return metadata;
}

export const grpcPlugin: TapRootPlugin = {
  manifest: {
    name: 'grpc',
    kind: 'executor',
    capabilities: ['doctor', 'executeRead'],
    priority: 100,
  },

  async doctor(input): Promise<DoctorCheck[]> {
    const ds = input.datasource;
    const protoRoot = resolveProtoRoot(undefined, ds.resolverHints);
    if (!protoRoot) {
      return [{ check: 'grpc proto-root', status: DoctorStatus.Warn, detail: "no resolverHints.protoRoot configured; doctor can only open a channel, not exercise a real method.", code: 'executor_configuration_missing' }];
    }
    try {
      const bundle = await loadGrpcPackage(protoRoot);
      const probe = ds.resolverHints?.probeService || listServices(bundle.protobufRoot)[0]?.name;
      if (!probe) {
        return [{ check: 'grpc proto load', status: DoctorStatus.Warn, detail: `loaded proto root ${protoRoot} but no service found to probe`, code: 'executor_configuration_missing' }];
      }
      const ServiceCtor = lookupServiceCtor(bundle.grpcPackage, probe);
      const client = buildClient(bundle.grpcModule, ServiceCtor, ds);
      try {
        await new Promise<void>((resolve, reject) => {
          client.waitForReady(Date.now() + RUNTIME_CONSTANTS.plugin.dbConnectTimeoutMs, (err) => (err ? reject(err) : resolve()));
        });
        return [{ check: 'grpc channel', status: DoctorStatus.Ok, detail: `connected to ${ds.connection.host}:${ds.connection.port} (${probe})` }];
      } finally {
        client.close();
      }
    } catch (err) {
      const detail = (err as Error).message || 'unknown grpc doctor error';
      return [{ check: 'grpc channel', status: DoctorStatus.Fail, detail, code: classifyExecutorDoctorCode(detail) }];
    }
  },

  async execute(request, creds): Promise<QueryResult> {
    const startedAt = nowIso();
    const start = Date.now();
    const query = parseQuery(request.query);
    const pp = request.pluginParams || {};
    const protoRoot = resolveProtoRoot(pp.protoRoot, request.datasource.resolverHints);
    if (!protoRoot) {
      throw new Error("grpc plugin needs a proto root. Pass --proto-root <dir> or set resolverHints.protoRoot on the datasource.");
    }
    const payload = resolveRequestPayload(request, pp.params || {});
    const bundle = await loadGrpcPackage(protoRoot);
    const { service, method } = resolveMethod(listServices(bundle.protobufRoot), query);
    const messages = requestMessages(payload, service, method);
    if (!pp.skipProtoValidate) {
      for (const [index, message] of messages.entries()) {
        const validationError = validateGrpcRequest(bundle.protobufRoot, method.requestType, message);
        if (validationError) {
          const position = Array.isArray(payload) ? `request[${index}]` : '';
          const skeleton = `taproot grpc describe --datasource ${request.datasource.name} --method ${method.name} --skeleton`;
          const detail = position ? `${position}: ${validationError.message}` : validationError.message;
          throw badInput(`${detail}. The request shape is printed by '${skeleton}'.`, {
            field: position ? `[${index}].${validationError.field}` : validationError.field,
            expected: validationError.expected,
          });
        }
      }
    }
    const ServiceCtor = lookupServiceCtor(bundle.grpcPackage, service);
    const client = getOrCreateClient(bundle.grpcModule, ServiceCtor, request.datasource, protoRoot, service);
    const metadata = callMetadata(bundle.grpcModule, creds, request.datasource);
    const deadlineMs = request.timeoutMs && request.timeoutMs > 0 ? request.timeoutMs : 5000;
    const streaming = isStreamingMethod(method);
    let rows: unknown[][];
    const warnings: string[] = [];
    let backupTimer: NodeJS.Timeout | undefined;
    try {
      const call = streaming
        ? callStreaming(client, method, messages, metadata, deadlineMs, request.signal).then((out) => {
          if (out.truncated) {
            warnings.push(`response stream stopped at ${out.responses.length} messages. Narrow the request or raise TAPROOT_GRPC_STREAM_MESSAGE_LIMIT.`);
          }
          return out.responses.map((value, seq) => [seq, value]);
        })
        : callUnary(client, method, messages[0], metadata, deadlineMs, request.signal).then((value) => [[value]]);
      rows = await Promise.race([
        call,
        new Promise<never>((_, reject) => {
          backupTimer = setTimeout(() => reject(queryTimeoutError(deadlineMs)), deadlineMs + 500);
        }),
      ]);
    } catch (err) {
      request.signal?.throwIfAborted();
      const msg = (err as Error).message || String(err);
      if (/deadline exceeded/i.test(msg)) throw queryTimeoutError(deadlineMs);
      throw err;
    } finally {
      clearTimeout(backupTimer);
    }
    return {
      datasource: request.datasource.name,
      plugin: 'grpc',
      capability: request.capability,
      query: { native: `${service}/${method.name}` },
      result: { columns: streaming ? ['seq', 'value'] : ['value'], rows },
      timings: {
        startedAt,
        endedAt: nowIso(),
        durationMs: Date.now() - start,
      },
      warnings,
      classification: 'success',
    };
  },
};
