import { isRecord } from './json-shapes.js';

const KbRelationSource = {
  Curated: 'curated',
  Derived: 'derived',
} as const;

type KbRelationSource = (typeof KbRelationSource)[keyof typeof KbRelationSource];

type RelationEndpoint = {
  service: string;
  table: string;
  column: string;
};

export type KbRelation = {
  id: string;
  from: RelationEndpoint;
  to: RelationEndpoint;
  relationship?: string;
  notes?: string;
  confidence?: number;
  source?: KbRelationSource;
};

function trimmedStringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function bareTableName(qualifiedName: string): string {
  const lastSegment = qualifiedName.split('.').pop();
  return lastSegment === undefined || lastSegment === '' ? qualifiedName : lastSegment;
}

function parseRelationEndpoint(raw: unknown): RelationEndpoint {
  const fields = isRecord(raw) ? raw : {};
  return {
    service: trimmedStringOrEmpty(fields.service),
    table: bareTableName(trimmedStringOrEmpty(fields.table)),
    column: trimmedStringOrEmpty(fields.column),
  };
}

function isCompleteEndpoint(endpoint: RelationEndpoint): boolean {
  return endpoint.service !== '' && endpoint.table !== '';
}

function parseRelation(item: unknown): KbRelation | undefined {
  if (!isRecord(item)) {
    return undefined;
  }
  const from = parseRelationEndpoint(item.from);
  const to = parseRelationEndpoint(item.to);
  if (!isCompleteEndpoint(from) || !isCompleteEndpoint(to)) {
    return undefined;
  }
  const id = trimmedStringOrEmpty(item.id);
  const relationship = trimmedStringOrEmpty(item.relationship);
  const notes = trimmedStringOrEmpty(item.notes);
  return {
    id: id === '' ? `${from.service}.${from.table}.${from.column}__${to.service}.${to.table}.${to.column}` : id,
    from,
    to,
    relationship: relationship === '' ? undefined : relationship,
    notes: notes === '' ? undefined : notes,
    confidence: typeof item.confidence === 'number' ? item.confidence : undefined,
    source: item.source === KbRelationSource.Derived ? KbRelationSource.Derived : KbRelationSource.Curated,
  };
}

export function normalizeRelations(raw: unknown[]): KbRelation[] {
  const relations: KbRelation[] = [];
  for (const item of raw) {
    const relation = parseRelation(item);
    if (relation !== undefined) {
      relations.push(relation);
    }
  }
  return relations;
}
