import type { AppContext } from '../../core/app.js';
import type { DatasourceGate } from '../datasource-check.js';
import type { SessionRegistry } from '../session-registry.js';
import type { QueryLimiter } from '../query-limiter.js';
import type { RpcRequest, RpcResponse } from '../types.js';

export type DaemonEndpoint = { socketPath: string } | { host: string; port: number };

export type HandlerDeps = {
  ctx: AppContext;
  sessions: SessionRegistry;
  queryLimiter: QueryLimiter;
  admitDatasource: DatasourceGate;
  endpoint: () => DaemonEndpoint;
  startedAt: number;
};

export type HandlerResult = {
  postWrite?: 'stopSocket';
};

export type Handler = (input: {
  req: RpcRequest;
  base: RpcResponse;
  deps: HandlerDeps;
  clientGone: AbortSignal;
}) => Promise<HandlerResult | void>;

export type DaemonMethod = {
  name: string;
  handle: Handler;
};
