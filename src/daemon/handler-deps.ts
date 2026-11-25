import type net from 'node:net';
import path from 'node:path';
import type { AppContext } from '../core/app.js';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { datasourceGate } from './datasource-check.js';
import type { DatasourceCheck } from './datasource-check.js';
import { endpointOf } from './listener.js';
import type { HandlerDeps } from './methods/types.js';
import { QueryLimiter } from './query-limiter.js';
import { SessionRegistry } from './session-registry.js';

type HandlerDepsInput = {
  ctx: AppContext;
  checkDatasource: DatasourceCheck | undefined;
  checkDatasourceTtlMs?: number;
};

export function createHandlerDeps(input: HandlerDepsInput, server: net.Server, startedAt: number): HandlerDeps {
  return {
    ctx: input.ctx,
    sessions: new SessionRegistry(path.join(input.ctx.paths.stateRoot, 'run')),
    queryLimiter: new QueryLimiter(RUNTIME_CONSTANTS.daemon.maxConcurrentQueries, RUNTIME_CONSTANTS.daemon.maxQueuedQueries),
    admitDatasource: datasourceGate(input.ctx, input.checkDatasource, input.checkDatasourceTtlMs),
    endpoint: () => endpointOf(server.address()),
    startedAt,
  };
}
