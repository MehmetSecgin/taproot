import { KbRelationSource } from '../types/core.js';
import type { KbRelation, RelationEndpoint, RelationEndpointStatus, RelationValidation, SchemaRelationEdge } from '../types/core.js';
import type { SchemaObservationEntry } from '../store/learning.js';

function str(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function bareTable(value: string): string {
  return value.split('.').pop() || value;
}

function endpoint(raw: unknown): RelationEndpoint {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { service: str(obj.service), table: bareTable(str(obj.table)), column: str(obj.column) };
}

export function normalizeRelations(raw: unknown[]): KbRelation[] {
  const out: KbRelation[] = [];
  for (const item of raw || []) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    const from = endpoint(obj.from);
    const to = endpoint(obj.to);
    if (!from.service || !from.table || !to.service || !to.table) continue;
    out.push({
      id: str(obj.id) || `${from.service}.${from.table}.${from.column}__${to.service}.${to.table}.${to.column}`,
      from,
      to,
      relationship: str(obj.relationship) || undefined,
      notes: str(obj.notes) || undefined,
      confidence: typeof obj.confidence === 'number' ? obj.confidence : undefined,
      source: obj.source === KbRelationSource.Derived ? KbRelationSource.Derived : KbRelationSource.Curated,
    });
  }
  return out;
}

function endpointLabel(e: RelationEndpoint): string {
  return e.column ? `${e.service}.${e.table}.${e.column}` : `${e.service}.${e.table}`;
}

export function liveColumnsFromSchemaContext(tables: Record<string, { columns?: string[] }>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const [table, ctx] of Object.entries(tables || {})) {
    out.set(bareTable(table).toLowerCase(), new Set((ctx.columns || []).map((c) => String(c).toLowerCase())));
  }
  return out;
}

export function relationsForTables(
  relations: KbRelation[],
  service: string,
  tables: string[],
  liveColumns?: Map<string, Set<string>>,
): SchemaRelationEdge[] {
  const svc = service.toLowerCase();
  const tableSet = new Set(tables.map((t) => bareTable(t).toLowerCase()));
  const edges: SchemaRelationEdge[] = [];
  const seen = new Set<string>();
  const staleColumn = (endpoint: RelationEndpoint): string | null => {
    if (!liveColumns) return null;
    if (endpoint.service.toLowerCase() !== svc) return null;
    const cols = liveColumns.get(endpoint.table.toLowerCase());
    if (!cols) return null;
    if (cols.has(endpoint.column.toLowerCase())) return null;
    return `${endpoint.service}.${endpoint.table}.${endpoint.column} not found in live schema`;
  };
  for (const rel of relations) {
    const fromHit = rel.from.service.toLowerCase() === svc && tableSet.has(rel.from.table.toLowerCase());
    const toHit = rel.to.service.toLowerCase() === svc && tableSet.has(rel.to.table.toLowerCase());
    if (!fromHit && !toHit) continue;
    const from = endpointLabel(rel.from);
    const to = endpointLabel(rel.to);
    const key = `${from}->${to}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const staleReason = (fromHit ? staleColumn(rel.from) : null) || (toHit ? staleColumn(rel.to) : null);
    const edge: SchemaRelationEdge = {
      from,
      to,
      relationship: rel.relationship,
      crossService: rel.from.service.toLowerCase() !== rel.to.service.toLowerCase(),
      notes: rel.notes,
    };
    if (staleReason) {
      edge.stale = true;
      edge.staleReason = staleReason;
    }
    edges.push(edge);
  }
  return edges.sort(
    (a, b) =>
      Number(Boolean(a.stale)) - Number(Boolean(b.stale)) ||
      Number(b.crossService) - Number(a.crossService) ||
      a.from.localeCompare(b.from),
  );
}

export function validateRelations(relations: KbRelation[], rows: SchemaObservationEntry[]): RelationValidation[] {
  const index = new Map<string, Map<string, Set<string>>>();
  for (const row of rows) {
    const service = str(row.service).toLowerCase();
    const table = bareTable(str(row.table)).toLowerCase();
    if (!service || !table) continue;
    const tableMap = index.get(service) || new Map<string, Set<string>>();
    const cols = tableMap.get(table) || new Set<string>();
    for (const col of row.columns || []) {
      const column = str(col.column).toLowerCase();
      if (column) cols.add(column);
    }
    tableMap.set(table, cols);
    index.set(service, tableMap);
  }
  const statusFor = (endpoint: RelationEndpoint): RelationEndpointStatus => {
    const tableMap = index.get(endpoint.service.toLowerCase());
    if (!tableMap) return 'unknown_service';
    const cols = tableMap.get(endpoint.table.toLowerCase());
    if (!cols) return 'missing_table';
    if (!cols.has(endpoint.column.toLowerCase())) return 'missing_column';
    return 'ok';
  };
  return relations.map((rel) => {
    const fromStatus = statusFor(rel.from);
    const toStatus = statusFor(rel.to);
    const stale = fromStatus === 'missing_table' || fromStatus === 'missing_column' || toStatus === 'missing_table' || toStatus === 'missing_column';
    return { id: rel.id, from: endpointLabel(rel.from), to: endpointLabel(rel.to), fromStatus, toStatus, stale };
  });
}

function isJoinKeyColumn(column: string): boolean {
  const c = column.toLowerCase();
  return c === 'id' || c.endsWith('_id') || c.endsWith('id');
}

interface ColumnOccurrence {
  service: string;
  table: string;
  column: string;
  isPrimaryKey: boolean;
}

export function deriveRelationCandidates(rows: SchemaObservationEntry[]): KbRelation[] {
  const byColumn = new Map<string, ColumnOccurrence[]>();
  for (const row of rows) {
    const service = str(row.service);
    const table = bareTable(str(row.table));
    if (!service || !table) continue;
    const pk = new Set((row.primaryKey || []).map((c) => c.toLowerCase()));
    for (const col of row.columns || []) {
      const column = str(col.column);
      if (!column || !isJoinKeyColumn(column)) continue;
      const norm = column.toLowerCase();
      const list = byColumn.get(norm) || [];
      list.push({ service, table, column, isPrimaryKey: pk.has(norm) });
      byColumn.set(norm, list);
    }
  }

  const candidates: KbRelation[] = [];
  const seen = new Set<string>();
  for (const [column, occurrences] of byColumn) {
    const services = new Set(occurrences.map((o) => o.service.toLowerCase()));
    if (services.size < 2) continue;
    if (column === 'id') continue;
    const anchor = occurrences.find((o) => o.isPrimaryKey);
    const onewayPerService = new Map<string, ColumnOccurrence>();
    for (const occ of occurrences) {
      const key = occ.service.toLowerCase();
      if (!onewayPerService.has(key)) onewayPerService.set(key, occ);
    }
    const reps = [...onewayPerService.values()];
    for (let i = 0; i < reps.length; i += 1) {
      for (let j = i + 1; j < reps.length; j += 1) {
        const a = anchor && anchor.service.toLowerCase() === reps[j].service.toLowerCase() ? reps[j] : reps[i];
        const b = a === reps[i] ? reps[j] : reps[i];
        if (a.service.toLowerCase() === b.service.toLowerCase()) continue;
        const from = b;
        const to = anchor ? anchor : a;
        if (from.service.toLowerCase() === to.service.toLowerCase()) continue;
        const id = `derived.${from.service}.${from.table}.${from.column}__${to.service}.${to.table}.${to.column}`;
        if (seen.has(id)) continue;
        seen.add(id);
        let confidence = 0.4;
        if (anchor) confidence += 0.2;
        confidence += 0.1;
        candidates.push({
          id,
          from: { service: from.service, table: from.table, column: from.column },
          to: { service: to.service, table: to.table, column: to.column },
          relationship: anchor ? 'many_to_one' : undefined,
          notes: `Auto-derived from shared join key '${column}' across services.`,
          confidence: Math.min(0.9, Number(confidence.toFixed(2))),
          source: KbRelationSource.Derived,
        });
      }
    }
  }
  return candidates.sort((a, b) => (b.confidence || 0) - (a.confidence || 0) || a.id.localeCompare(b.id));
}
