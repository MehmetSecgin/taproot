import { badInput } from '../../core/taproot-error.js';
import { listServices } from '../../core/grpc-introspect.js';
import type { GrpcMethodShape } from '../../core/grpc-introspect.js';
import { validateGrpcRequest } from '../../core/grpc-proto-validate.js';
import { loadGrpcPackage, resolveProtoRoot } from '../../core/proto-loader.js';
import type { GrpcBundle } from '../../core/proto-loader.js';
import type { QueryRequest } from '../../types/plugin.js';
import { requestMessages, resolveRequestPayload } from './request-payload.js';
import { parseServiceMethodRef, resolveMethod } from './resolve-method.js';

export type PreparedCall = {
  bundle: GrpcBundle;
  protoRoot: string;
  service: string;
  method: GrpcMethodShape;
  messages: Record<string, unknown>[];
};

type ValidationContext = {
  prepared: PreparedCall;
  datasourceName: string;
  isBatch: boolean;
};

function requireProtoRoot(request: QueryRequest): string {
  const protoRoot = resolveProtoRoot(request.pluginParams?.protoRoot, request.datasource.resolverHints);
  if (protoRoot === undefined) {
    throw new Error("grpc plugin needs a proto root. Pass --proto-root <dir> or set resolverHints.protoRoot on the datasource.");
  }
  return protoRoot;
}

function assertMessageValid({ prepared, datasourceName, isBatch }: ValidationContext, index: number): void {
  const validationError = validateGrpcRequest(prepared.bundle.protobufRoot, prepared.method.requestType, prepared.messages[index]);
  if (validationError === null) {
    return;
  }
  const position = isBatch ? `request[${index}]` : '';
  const skeleton = `taproot grpc describe --datasource ${datasourceName} --method ${prepared.method.name} --skeleton`;
  const detail = position === '' ? validationError.message : `${position}: ${validationError.message}`;
  throw badInput(`${detail}. The request shape is printed by '${skeleton}'.`, {
    field: position === '' ? validationError.field : `[${index}].${validationError.field}`,
    expected: validationError.expected,
  });
}

export async function prepareCall(request: QueryRequest): Promise<PreparedCall> {
  const ref = parseServiceMethodRef(request.query);
  const protoRoot = requireProtoRoot(request);
  const payload = resolveRequestPayload(request, request.pluginParams?.params ?? {});
  const bundle = await loadGrpcPackage(protoRoot);
  const { service, method } = resolveMethod(listServices(bundle.protobufRoot), ref);
  const prepared = { bundle, protoRoot, service, method, messages: requestMessages(payload, service, method) };
  if (request.pluginParams?.skipProtoValidate !== true) {
    for (const index of prepared.messages.keys()) {
      assertMessageValid({ prepared, datasourceName: request.datasource.name, isBatch: Array.isArray(payload) }, index);
    }
  }
  return prepared;
}

