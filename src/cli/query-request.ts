import { badInput } from '../core/error-classification.js';
import type { QueryExecutionRequest, QueryTarget } from '../core/execute-query.js';
import type { QueryOpts } from './types.js';

function queryText(opts: QueryOpts): string {
  if (opts.sql && opts.query) {
    throw badInput('pass the query text once, with --sql or --query, not both.');
  }
  const text = opts.sql || opts.query || '';
  if (opts.explain && !text) {
    throw badInput('--explain requires --sql.');
  }
  return text;
}

export function queryExecutionRequest(
  opts: QueryOpts,
  target: Pick<QueryTarget, 'env' | 'namespace' | 'service'>,
  allowDiscovery: boolean,
  timeoutMs: number,
): QueryExecutionRequest {
  return {
    datasource: opts.datasource,
    optsEnv: opts.env,
    env: target.env,
    namespace: target.namespace,
    service: target.service,
    query: queryText(opts),
    params: opts.param || [],
    allowDiscovery,
    allowMutate: Boolean(opts.allowMutate),
    allowPartitionScan: Boolean(opts.allowPartitionScan),
    explain: Boolean(opts.explain),
    rowsObject: Boolean(opts.rowsObject),
    jsonExtract: opts.jsonExtract || [],
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
