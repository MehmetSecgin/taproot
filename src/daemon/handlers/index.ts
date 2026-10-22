import { RpcMethod } from '../types.js';
import { handleDaemonStatus, handleDaemonStop } from './daemon-status.js';
import { handleQueryExecute } from './query-execute.js';
import type { Handler } from './types.js';

export const HANDLERS: Map<string, Handler> = new Map([
  [RpcMethod.DaemonStatus, handleDaemonStatus],
  [RpcMethod.DaemonStop, handleDaemonStop],
  [RpcMethod.QueryExecute, handleQueryExecute],
]);

export type { Handler, HandlerDeps, HandlerResult } from './types.js';
