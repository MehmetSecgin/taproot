import type { DatasourceProfile, RpcEnumShape, RpcMessageShape, RpcServiceShape, SchemaProvenance } from '../types/core.js';
import { readJsonFile, writeJsonFile } from '../core/json.js';
import { str } from '../core/strings.js';
import { pickBestByKey } from './learning-utils.js';
import type { GrpcServiceSchemaEntry } from './learning-types.js';

export function loadGrpcSchemas(file: string): GrpcServiceSchemaEntry[] {
  return readJsonFile<GrpcServiceSchemaEntry[]>(file, []);
}

export function saveGrpcSchemas(file: string, rows: GrpcServiceSchemaEntry[]): void {
  writeJsonFile(file, rows);
}

export function filterGrpcSchemas(
  rows: GrpcServiceSchemaEntry[],
  service?: string,
): GrpcServiceSchemaEntry[] {
  if (!service) return rows;
  return rows.filter((r) => r.service === service);
}

export function upsertGrpcSchema(
  rows: GrpcServiceSchemaEntry[],
  input: {
    datasource: DatasourceProfile;
    protoRoot: string;
    source?: SchemaProvenance;
    services: RpcServiceShape[];
    messages: Record<string, RpcMessageShape>;
    enums: Record<string, RpcEnumShape>;
    now: string;
  },
): GrpcServiceSchemaEntry {
  const datasource = input.datasource;
  const service = String(datasource.service || datasource.name);
  const key = service;
  const idx = rows.findIndex((r) => r.key === key);
  const prev = idx >= 0 ? rows[idx] : undefined;
  const entry: GrpcServiceSchemaEntry = {
    key,
    datasource: datasource.name,
    env: str(datasource.env),
    service,
    kind: datasource.kind,
    protoRoot: input.protoRoot,
    services: input.services,
    messages: input.messages,
    enums: input.enums,
    firstSeenAt: prev?.firstSeenAt || input.now,
    lastSeenAt: input.now,
    sources: Array.from(
      new Set([...(prev?.sources || []), input.source || 'refreshed-metadata']),
    ).sort() as SchemaProvenance[],
  };
  if (idx >= 0) rows[idx] = entry;
  else rows.push(entry);
  return entry;
}

export function compactGrpcSchemas(
  rows: GrpcServiceSchemaEntry[],
): GrpcServiceSchemaEntry[] {
  return pickBestByKey(rows, (a, b) => a.lastSeenAt > b.lastSeenAt);
}

export function pruneGrpcSchemas(
  rows: GrpcServiceSchemaEntry[],
  cutoffMs: number,
): GrpcServiceSchemaEntry[] {
  return rows.filter((r) => new Date(r.lastSeenAt).getTime() >= cutoffMs);
}
