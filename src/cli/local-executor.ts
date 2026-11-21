import type { Command } from 'commander';
import { buildContext, environmentPolicy } from '../core/app.js';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { DATASOURCE_COLUMNS, listDatasources } from '../core/datasource-list.js';
import { deriveQueryTarget } from '../core/execute-query.js';
import { parseTimeoutMs, queryBudgetMs } from '../core/query-timeout.js';
import { ensureStarterRuntime } from '../core/runtime-init.js';
import { readSchema, schemaDatasource } from '../core/schema-read.js';
import { queryExecutionRequest } from './query-request.js';
import { callLocalDaemon } from './local-daemon.js';
import { runDirectQuery, verboseLog } from './query-direct.js';
import { replyData } from './query-present.js';
import { daemonRoute, queryRoute } from './query-route.js';
import { RpcMethod } from '../daemon/types.js';
import type { TapRootPlugin } from '../types/core.js';
import type { LocalExecutor } from './types.js';

export function localExecutor(input: { plugins: TapRootPlugin[] }): LocalExecutor {
  let program: Command | undefined;

  const context = () => {
    const opts = program?.opts() ?? {};
    return buildContext({
      kbDir: opts.kbDir ? String(opts.kbDir) : undefined,
      verbose: Boolean(opts.verbose),
      plugins: input.plugins,
      useKeychain: true,
    });
  };

  return {
    context,

    addOptions(target) {
      program = target;
      target
        .option('--kb-dir <path>', 'Path to the KB directory (containing services.json). Overrides TAPROOT_KB_DIR and the directory saved by `taproot init --kb-dir`.')
        .option('--verbose', 'Diagnostics on stderr as JSON lines', false);
    },

    async query(opts) {
      const ctx = context();
      const logVerbose = verboseLog(ctx);
      ensureStarterRuntime(ctx);
      const timeoutDefault = ctx.runtimeConfigStore.queryTimeoutMs() ?? RUNTIME_CONSTANTS.query.defaultTimeoutMs;
      const timeoutMs = parseTimeoutMs(opts.timeout, timeoutDefault);
      const target = deriveQueryTarget(ctx, opts);
      const allowDiscovery = Boolean(opts.allowDiscovery) || environmentPolicy(ctx, target.env).allowDiscoveryByDefault;
      const request = queryExecutionRequest(opts, target, allowDiscovery, timeoutMs);
      const route = queryRoute(request);
      logVerbose(route === 'direct' ? 'running direct query mode' : 'attempting daemon query path');
      if (route === 'daemon') {
        const rpc = await callLocalDaemon(
          { method: RpcMethod.QueryExecute, params: { ...request }, timeoutMs: queryBudgetMs(request.timeoutMs) + RUNTIME_CONSTANTS.rpc.queryReplyMarginMs },
          logVerbose,
        );
        if (rpc?.ok) logVerbose(`daemon request=${rpc.requestId} session=${rpc.meta?.sessionId || 'n/a'}`);
        if (rpc) return rpc;
      }
      return runDirectQuery(request, ctx);
    },

    async listDatasources(request) {
      return listDatasources(context(), request, DATASOURCE_COLUMNS, undefined);
    },

    async readSchema(request) {
      const ctx = context();
      if (daemonRoute() === 'daemon') {
        const params = { datasource: request.datasource, tables: request.tables };
        const rpc = await callLocalDaemon({ method: RpcMethod.SchemaRead, params, timeoutMs: queryBudgetMs(RUNTIME_CONSTANTS.query.catalogTimeoutMs) }, verboseLog(ctx));
        if (rpc) return replyData(rpc);
      }
      return readSchema(ctx, schemaDatasource(ctx, request.datasource), request.tables, undefined);
    },
  };
}
