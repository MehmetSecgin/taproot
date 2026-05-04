import type { QueryMemory, SchemaContext } from '../types/core.js';

export interface RpcRequest {
  protocolVersion: number;
  requestId: string;
  method: string;
  params: Record<string, unknown>;
}

export interface RpcError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export interface RpcResponse {
  protocolVersion: number;
  requestId: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: RpcError;
  meta: {
    runId?: string;
    sessionId?: string;
    schemaContext?: SchemaContext;
    queryMemory?: QueryMemory;
    timings?: {
      durationMs: number;
    };
  };
}

export type SessionState = 'recovering' | 'opening' | 'ready' | 'degraded' | 'closing' | 'closed';

export interface SessionResource {
  id: string;
  type: 'process' | 'pool' | 'connector';
  kind: string;
  status: 'ready' | 'degraded' | 'closed';
  pid?: number;
  pgid?: number;
  createdAt: string;
}

export interface SessionRecord {
  sessionId: string;
  fingerprintVersion: string;
  fingerprint: string;
  datasourceName: string;
  env?: string;
  namespace?: string;
  service?: string;
  kind?: string;
  state: SessionState;
  createdAt: string;
  lastUsedAt: string;
  idleTtlMs: number;
  hardTtlMs: number;
  leaseCount: number;
  resources: SessionResource[];
  metrics: {
    queryCount: number;
    successCount: number;
    failureCount: number;
    p50DurationMs: number;
  };
  degraded: {
    attempts: number;
    nextRevalidateAt: string;
    lastErrorCode: string;
  };
}

export interface SessionCheckpoint {
  schemaVersion: number;
  updatedAt: string;
  sessions: SessionRecord[];
}
