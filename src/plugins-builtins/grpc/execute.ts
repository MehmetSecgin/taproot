import { lookupServiceCtor } from '../../core/proto-loader.js';
import type { GrpcModule } from '../../core/proto-loader.js';
import { nowIso } from '../../core/time.js';
import type { QueryRequest, QueryResult } from '../../types/plugin.js';
import { isNonEmpty } from '../../core/text-presence.js';
import { isStreamingMethod } from './call.js';
import { getOrCreateClient } from './client-cache.js';
import { callWithDeadline } from './deadline-race.js';
import { prepareCall } from './prepare-call.js';

type CallMetadata = InstanceType<GrpcModule['Metadata']>;

const DEFAULT_GRPC_DEADLINE_MS = 5000;
const METADATA_HINT_PREFIX = 'metadata.';

function callMetadata(grpcModule: GrpcModule, credentials: Record<string, string>, datasource: QueryRequest['datasource']): CallMetadata {
  const metadata = new grpcModule.Metadata();
  if (isNonEmpty(credentials.token)) {
    metadata.add('authorization', `Bearer ${credentials.token}`);
  }
  for (const [key, value] of Object.entries(datasource.resolverHints ?? {})) {
    if (key.startsWith(METADATA_HINT_PREFIX)) {
      metadata.add(key.slice(METADATA_HINT_PREFIX.length), value);
    }
  }
  return metadata;
}

function deadlineMsOf(request: QueryRequest): number {
  const { timeoutMs } = request;
  return timeoutMs !== undefined && timeoutMs > 0 ? timeoutMs : DEFAULT_GRPC_DEADLINE_MS;
}

export async function executeGrpc(request: QueryRequest, credentials: Record<string, string>): Promise<QueryResult> {
  const startedAt = nowIso();
  const start = Date.now();
  const { bundle, protoRoot, service, method, messages } = await prepareCall(request);
  const client = getOrCreateClient({
    grpcModule: bundle.grpcModule,
    serviceConstructor: lookupServiceCtor(bundle.grpcPackage, service),
    datasource: request.datasource,
    protoRoot,
    serviceName: service,
  });
  const metadata = callMetadata(bundle.grpcModule, credentials, request.datasource);
  const options = { client, method, metadata, deadlineMs: deadlineMsOf(request), signal: request.signal };
  const { rows, warnings } = await callWithDeadline(request, options, messages);
  return {
    datasource: request.datasource.name,
    plugin: 'grpc',
    capability: request.capability,
    query: { native: `${service}/${method.name}` },
    result: { columns: isStreamingMethod(method) ? ['seq', 'value'] : ['value'], rows },
    timings: { startedAt, endedAt: nowIso(), durationMs: Date.now() - start },
    warnings,
    classification: 'success',
  };
}
