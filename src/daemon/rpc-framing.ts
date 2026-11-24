import { randomUUID } from 'node:crypto';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { connectivity } from '../core/taproot-error.js';
import { TAPROOT_VERSION } from '../core/version.js';
import type { RpcRequest, RpcResponse } from './types.js';

type RpcRequestInput = {
  method: string;
  params?: Record<string, unknown>;
};

export function encodeRequest(input: RpcRequestInput): string {
  const request: RpcRequest = {
    protocolVersion: RUNTIME_CONSTANTS.protocolVersion,
    clientVersion: TAPROOT_VERSION,
    requestId: randomUUID(),
    method: input.method,
    params: input.params ?? {},
  };
  return `${JSON.stringify(request)}\n`;
}

function isRpcReply(value: unknown): value is RpcResponse {
  return typeof value === 'object' && value !== null;
}

export function parseReply(line: string): RpcResponse {
  const parsed: unknown = JSON.parse(line);
  if (!isRpcReply(parsed)) {
    throw connectivity('daemon reply was not a JSON object');
  }
  return parsed;
}
