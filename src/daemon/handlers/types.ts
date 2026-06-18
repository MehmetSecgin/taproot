import type { AppContext } from '../../core/app.js';
import type { SessionRegistry } from '../session-registry.js';
import type { QueryLimiter } from '../query-limiter.js';
import type { RpcRequest, RpcResponse } from '../types.js';

export interface HandlerDeps {
  ctx: AppContext;
  sessions: SessionRegistry;
  queryLimiter: QueryLimiter;
  socketPath: string;
  startedAt: number;
}

export interface HandlerResult {
  postWrite?: 'stopSocket';
}

export type Handler = (input: {
  req: RpcRequest;
  base: RpcResponse;
  deps: HandlerDeps;
}) => Promise<HandlerResult | void>;
