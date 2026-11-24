import { RUNTIME_CONSTANTS } from '../../core/constants.js';
import { badInput } from '../../core/taproot-error.js';
import type { GrpcMethodShape } from '../../core/grpc-introspect.js';
import type { QueryRequest } from '../../types/plugin.js';
import { isPlainRecord, isRecord } from '../../core/json-shapes.js';

type RequestPayload = Record<string, unknown> | unknown[];

const NUMERIC_PARAM = /^-?\d+(?:\.\d+)?$/u;

function decodeRequestJson(raw: string): RequestPayload {
  const parsed: unknown = JSON.parse(raw);
  if (isRecord(parsed)) {
    return parsed;
  }
  throw new Error('request JSON must decode to an object, or an array of objects for a client-streaming or bidi method');
}

function parseRequestJson(raw: string): RequestPayload {
  try {
    return decodeRequestJson(raw);
  } catch (error) {
    throw new Error(`invalid --request-json: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function coerceParamValue(value: string): unknown {
  if (NUMERIC_PARAM.test(value)) {
    return Number(value);
  }
  return value === 'true' || value === 'false' ? value === 'true' : value;
}

export function resolveRequestPayload(request: QueryRequest, keyValueParams: Record<string, string>): RequestPayload {
  const raw = request.pluginParams?.requestJson;
  if (typeof raw === 'string' && raw.trim() !== '') {
    return parseRequestJson(raw);
  }
  return Object.fromEntries(Object.entries(keyValueParams).map(([key, value]) => [key, coerceParamValue(value)]));
}

function assertWithinStreamLimit(payload: unknown[]): void {
  const limit = RUNTIME_CONSTANTS.grpc.streamMessageLimit;
  if (payload.length > limit) {
    throw badInput(`stream request has ${payload.length} messages; the limit is ${limit} per call. Split the batch or raise TAPROOT_GRPC_STREAM_MESSAGE_LIMIT.`);
  }
}

function toMessages(payload: unknown[]): Record<string, unknown>[] {
  const messages: Record<string, unknown>[] = [];
  for (const [index, message] of payload.entries()) {
    if (!isPlainRecord(message)) {
      throw badInput(`request[${index}] must be a JSON object`, { field: `[${index}]`, expected: 'object' });
    }
    messages.push(message);
  }
  return messages;
}

export function requestMessages(payload: RequestPayload, service: string, method: GrpcMethodShape): Record<string, unknown>[] {
  if (!Array.isArray(payload)) {
    return [payload];
  }
  if (method.requestStream !== true) {
    throw badInput(`${service}/${method.name} takes one request message, not an array. Pass a JSON object in --request-json.`);
  }
  assertWithinStreamLimit(payload);
  return toMessages(payload);
}
