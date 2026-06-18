import { RpcMethod } from '../types.js';
import { handleDaemonStatus, handleDaemonStop } from './daemon-status.js';
import { handleSessionOpen, handleSessionList, handleSessionInspect, handleSessionClose, handleSessionCloseAll } from './session.js';
import { handleQueryExecute } from './query-execute.js';
import type { Handler } from './types.js';

export const HANDLERS: Map<string, Handler> = new Map([
  [RpcMethod.DaemonStatus, handleDaemonStatus],
  [RpcMethod.DaemonStop, handleDaemonStop],
  [RpcMethod.SessionOpen, handleSessionOpen],
  [RpcMethod.SessionList, handleSessionList],
  [RpcMethod.SessionInspect, handleSessionInspect],
  [RpcMethod.SessionClose, handleSessionClose],
  [RpcMethod.SessionCloseAll, handleSessionCloseAll],
  [RpcMethod.QueryExecute, handleQueryExecute],
]);

export type { Handler, HandlerDeps, HandlerResult } from './types.js';
