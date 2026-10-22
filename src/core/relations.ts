import { KbRelationSource } from '../types/core.js';
import type { KbRelation, RelationEndpoint } from '../types/core.js';

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
