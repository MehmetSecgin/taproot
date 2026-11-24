import type { QueryPhaseTimings, QueryResult } from '../types/plugin.js';
import type { SchemaContext } from '../types/schema-context.js';

export const RpcMethod = {
  DaemonStatus: 'daemon.status',
  DaemonStop: 'daemon.stop',
  QueryExecute: 'query.execute',
  DatasourceList: 'datasource.list',
  SchemaRead: 'schema.read',
} as const;
export type RpcMethod = (typeof RpcMethod)[keyof typeof RpcMethod];

export const DAEMON_VERSION_MISMATCH = 'DAEMON_VERSION_MISMATCH';

export type RpcRequest = {
  protocolVersion: number;
  clientVersion: string;
  requestId: string;
  method: string;
  params: Record<string, unknown>;
};

type RpcError = {
  code: string;
  message: string;
  details?: unknown;
};

export type RpcResponse = {
  protocolVersion: number;
  requestId: string;
  ok: boolean;
  data?: Record<string, unknown>;
  error?: RpcError;
  meta: {
    sessionId?: string;
    schemaContext?: SchemaContext;
    resolved?: QueryResult['resolved'];
    timings?: {
      durationMs: number;
    };
    phases?: QueryPhaseTimings;
  };
};
