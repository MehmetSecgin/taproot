import type { AppContext } from '../core/app.js';
import { ensureStarterRuntime } from '../core/runtime-init.js';
import { queryThroughDaemon } from './local-daemon.js';
import { runDirectQuery } from './query-direct.js';
import type { QueryReply } from './query-reply.js';
import { resolveQueryRequest } from './query-request.js';
import { queryRoute } from './query-route.js';
import type { QueryCliOptions } from './types.js';
import { createVerboseLog } from './verbose-log.js';

export async function runLocalQuery(ctx: AppContext, opts: QueryCliOptions): Promise<QueryReply> {
  const logVerbose = createVerboseLog(ctx);
  ensureStarterRuntime(ctx);
  const request = resolveQueryRequest(ctx, opts);
  const route = queryRoute(request);
  logVerbose(route === 'direct' ? 'running direct query mode' : 'attempting daemon query path');
  const daemonReply = route === 'daemon' ? await queryThroughDaemon(request, logVerbose) : undefined;
  return daemonReply ?? runDirectQuery(request, ctx);
}
