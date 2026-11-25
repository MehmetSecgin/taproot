import type { AppContext } from '../core/app.js';
import { RUNTIME_CONSTANTS } from '../core/constants.js';
import { badInput } from '../core/taproot-error.js';
import { deriveQueryTarget } from '../core/query-target.js';
import type { QueryTarget } from '../core/query-target.js';
import type { QueryExecutionRequest } from '../core/query-types.js';
import { parseTimeoutMs } from '../core/query-timeout.js';
import type { QueryCliOptions } from './types.js';
import { emptyToUndefined } from '../core/text-presence.js';

function queryText(opts: QueryCliOptions): string {
  const sql = emptyToUndefined(opts.sql);
  const query = emptyToUndefined(opts.query);
  if (sql !== undefined && query !== undefined) {
    throw badInput('pass the query text once, with --sql or --query, not both.');
  }
  const text = sql ?? query ?? '';
  if (opts.explain === true && text === '') {
    throw badInput('--explain requires --sql.');
  }
  return text;
}

type QueryRequestSettings = {
  target: Pick<QueryTarget, 'env' | 'namespace' | 'service'>;
  allowDiscovery: boolean;
  timeoutMs: number;
};

export function queryExecutionRequest(opts: QueryCliOptions, settings: QueryRequestSettings): QueryExecutionRequest {
  const { target, allowDiscovery, timeoutMs } = settings;
  return {
    datasource: opts.datasource,
    optsEnv: opts.env,
    env: target.env,
    namespace: target.namespace,
    service: target.service,
    query: queryText(opts),
    params: opts.param ?? [],
    allowDiscovery,
    allowMutate: Boolean(opts.allowMutate),
    allowPartitionScan: Boolean(opts.allowPartitionScan),
    explain: Boolean(opts.explain),
    rowsObject: Boolean(opts.rowsObject),
    jsonExtract: opts.jsonExtract ?? [],
    proto: opts.proto,
    protoRoot: opts.protoRoot,
    allowFlush: Boolean(opts.allowFlush),
    allowKeys: Boolean(opts.allowKeys),
    requestJson: opts.requestJson,
    skipProtoValidate: Boolean(opts.skipProtoValidate),
    timeoutMs,
    maxRows: undefined,
    tz: opts.tz,
  };
}

export function resolveQueryRequest(ctx: AppContext, opts: QueryCliOptions): QueryExecutionRequest {
  const timeoutDefault = ctx.runtimeConfigStore.queryTimeoutMs() ?? RUNTIME_CONSTANTS.query.defaultTimeoutMs;
  const timeoutMs = parseTimeoutMs(opts.timeout, timeoutDefault);
  const target = deriveQueryTarget(ctx, opts);
  const allowDiscovery = opts.allowDiscovery === true || ctx.runtimeConfigStore.environmentPolicy(target.env).allowDiscoveryByDefault;
  return queryExecutionRequest(opts, { target, allowDiscovery, timeoutMs });
}
