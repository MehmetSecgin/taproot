import type { AppContext } from '../core/app.js';
import { refreshGrpcSchemaForDatasource, supportsGrpcSchema } from '../core/schema-refresh.js';
import { EnsuredBy } from '../types/core.js';
import type { DatasourceProfile, RpcEnumShape, RpcMessageShape } from '../types/core.js';
import type { GrpcServiceSchemaEntry } from '../store/learning.js';
import { isTargetedRequest, resolveDatasource, unresolvedNextCommand, type LearnTargetOpts } from './learn-common.js';

export interface GrpcMethodRow {
  service: string;
  method: string;
  request: string;
  response: string;
  streams: string;
}

export interface GrpcSchemaSnapshot {
  datasource: string | null;
  service: string | null;
  protoRoot: string | null;
  serviceCount: number;
  methodCount: number;
  messageCount: number;
  enumCount: number;
  methods: GrpcMethodRow[];
  messages?: Record<string, RpcMessageShape>;
  enums?: Record<string, RpcEnumShape>;
  lastSeenAt?: string;
  emptyReason: string | null;
  suggestedNextCommand: string | null;
  ensuredBy: EnsuredBy;
}

function emptyGrpcSnapshot(input: { datasource?: DatasourceProfile; emptyReason: string | null; suggestedNextCommand: string | null; ensuredBy: EnsuredBy }): GrpcSchemaSnapshot {
  return {
    datasource: input.datasource?.name || null,
    service: input.datasource ? String(input.datasource.service || input.datasource.name) : null,
    protoRoot: null,
    serviceCount: 0,
    methodCount: 0,
    messageCount: 0,
    enumCount: 0,
    methods: [],
    emptyReason: input.emptyReason,
    suggestedNextCommand: input.suggestedNextCommand,
    ensuredBy: input.ensuredBy,
  };
}

function buildGrpcSnapshot(entry: GrpcServiceSchemaEntry, detailed: boolean, ensuredBy: EnsuredBy): GrpcSchemaSnapshot {
  const methods: GrpcMethodRow[] = entry.services.flatMap((svc) =>
    svc.methods.map((m) => ({
      service: svc.name,
      method: m.name,
      request: m.requestType,
      response: m.responseType,
      streams: [m.requestStream ? 'req' : '', m.responseStream ? 'resp' : ''].filter(Boolean).join('+') || '',
    })),
  );
  const snapshot: GrpcSchemaSnapshot = {
    datasource: entry.datasource,
    service: entry.service,
    protoRoot: entry.protoRoot,
    serviceCount: entry.services.length,
    methodCount: methods.length,
    messageCount: Object.keys(entry.messages).length,
    enumCount: Object.keys(entry.enums).length,
    methods,
    lastSeenAt: entry.lastSeenAt,
    emptyReason: null,
    suggestedNextCommand: null,
    ensuredBy,
  };
  if (detailed) {
    snapshot.messages = entry.messages;
    snapshot.enums = entry.enums;
  }
  return snapshot;
}

export async function ensureGrpcSchemaSnapshot(
  ctx: AppContext,
  opts: LearnTargetOpts & { detailed?: boolean; refresh?: boolean },
): Promise<GrpcSchemaSnapshot> {
  const datasource = await resolveDatasource(ctx, opts);
  const targeted = isTargetedRequest(opts);
  if (!datasource) {
    return emptyGrpcSnapshot({
      emptyReason: targeted ? 'datasource_unresolved' : 'no_learning_yet',
      suggestedNextCommand: targeted ? unresolvedNextCommand(opts, ctx) : null,
      ensuredBy: targeted ? EnsuredBy.Unresolved : EnsuredBy.Empty,
    });
  }
  const service = String(datasource.service || datasource.name);
  let entry = ctx.learningStore.grpcSchemas(service)[0];
  let ensuredBy: EnsuredBy = entry ? EnsuredBy.CachedLearning : EnsuredBy.Empty;
  if ((!entry || opts.refresh) && supportsGrpcSchema(datasource)) {
    await refreshGrpcSchemaForDatasource(ctx, datasource);
    entry = ctx.learningStore.grpcSchemas(service)[0];
    ensuredBy = EnsuredBy.RefreshedIntrospection;
  }
  if (!entry) {
    const refreshable = supportsGrpcSchema(datasource);
    return emptyGrpcSnapshot({
      datasource,
      emptyReason: refreshable ? 'grpc_schema_refresh_required' : 'learning_unsupported',
      suggestedNextCommand: refreshable ? `taproot learn refresh-schema --datasource ${datasource.name}` : null,
      ensuredBy: EnsuredBy.Empty,
    });
  }
  return buildGrpcSnapshot(entry, Boolean(opts.detailed), ensuredBy);
}

export function readGrpcSchemaSnapshot(
  ctx: AppContext,
  datasource: DatasourceProfile | undefined,
  targeted: boolean,
  opts: LearnTargetOpts & { detailed?: boolean },
): GrpcSchemaSnapshot {
  if (!datasource) {
    return emptyGrpcSnapshot({
      emptyReason: targeted ? 'datasource_unresolved' : 'no_learning_yet',
      suggestedNextCommand: targeted ? unresolvedNextCommand(opts, ctx) : null,
      ensuredBy: targeted ? EnsuredBy.Unresolved : EnsuredBy.Empty,
    });
  }
  const service = String(datasource.service || datasource.name);
  const entry = ctx.learningStore.grpcSchemas(service)[0];
  if (!entry) {
    const refreshable = supportsGrpcSchema(datasource);
    return emptyGrpcSnapshot({
      datasource,
      emptyReason: refreshable ? 'grpc_schema_refresh_required' : 'learning_unsupported',
      suggestedNextCommand: refreshable ? `taproot learn refresh-schema --datasource ${datasource.name}` : null,
      ensuredBy: EnsuredBy.Empty,
    });
  }
  return buildGrpcSnapshot(entry, Boolean(opts.detailed), EnsuredBy.CachedLearning);
}
