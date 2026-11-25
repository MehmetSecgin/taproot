import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { isRecord } from '../core/json-shapes.js';
import { isTruthy } from '../core/text-presence.js';
import type { RpcRequest } from './types.js';

function isRpcRequestEnvelope(value: unknown): value is RpcRequest {
  return isRecord(value) && isTruthy(value.requestId) && isTruthy(value.method) && isRecord(value.params);
}

export function parseRequestLine(line: string): RpcRequest {
  const parsed: unknown = JSON.parse(line);
  const protocolVersion = isRecord(parsed) ? parsed.protocolVersion : undefined;
  if (protocolVersion !== RUNTIME_CONSTANTS.protocolVersion) {
    throw new Error(`Unsupported protocolVersion=${String(protocolVersion)}`);
  }
  if (!isRpcRequestEnvelope(parsed)) {
    throw new Error('Invalid RPC request envelope');
  }
  return parsed;
}
