import type { QueryRequest } from '../../types/plugin.js';
import { misconfiguredDatasource } from '../../core/taproot-error.js';
import { resolveProtoRoot } from '../../core/proto-loader.js';
import { firstNonEmpty } from '../../core/text-presence.js';
import type { GateOptions } from './command-policy.js';
import { hasDatabase } from '../../core/has-database.js';
import type { ProtoDecoding } from './reply-decode.js';

export function gateOptionsFor(request: QueryRequest): GateOptions {
  const { policy } = request.datasource;
  const pluginParams = request.pluginParams ?? {};
  return {
    capability: request.capability,
    policyAllowsMutate: policy.allowMutate,
    allowedCapabilities: policy.allowedCapabilities,
    allowFlush: Boolean(pluginParams.allowFlush),
    allowKeys: Boolean(pluginParams.allowKeys),
    strictKeyspace: policy.strictKeyspace === true,
  };
}

export function assertDatabaseSet(datasource: QueryRequest['datasource']): void {
  if (datasource.policy.requireDatabase === true && !hasDatabase(datasource.connection.database)) {
    throw misconfiguredDatasource(`redis datasource '${datasource.name}' requires a database number but has none; set it with 'taproot datasource add ... --database <n>'.`);
  }
}

export function resolveProtoDecoding(request: QueryRequest): ProtoDecoding | undefined {
  const pluginParams = request.pluginParams ?? {};
  const hints = request.datasource.resolverHints;
  const protoRoot = resolveProtoRoot(pluginParams.protoRoot, hints);
  const protoMessage = firstNonEmpty(pluginParams.protoMessage, hints?.protoMessage)?.trim();
  if (protoMessage === undefined || protoMessage === '') {
    return undefined;
  }
  if (protoRoot === undefined) {
    throw new Error("proto decoding requested but no proto root. Pass --proto-root <dir> or set resolverHints.protoRoot on the datasource.");
  }
  return { protoRoot, protoMessage };
}
