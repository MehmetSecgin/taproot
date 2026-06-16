import { describe, expect, it } from 'vitest';
import { normalizeRelations, relationsForTables, deriveRelationCandidates, validateRelations } from '../src/core/relations.js';
import type { SchemaObservationEntry } from '../src/store/learning.js';

function obs(service: string, table: string, columns: string[], primaryKey: string[] = []): SchemaObservationEntry {
  return {
    key: `${service}|${table}`,
    datasource: `${service}-ds`,
    env: 'qa',
    service,
    kind: 'mysql',
    database: service,
    target: '',
    table,
    aliases: [],
    columns: columns.map((column) => ({ column } as SchemaObservationEntry['columns'][number])),
    primaryKey,
    indexes: [],
    firstSeenAt: '2026-01-01T00:00:00Z',
    lastSeenAt: '2026-01-01T00:00:00Z',
    sightings: 1,
    confidence: 1,
    sources: ['refreshed-metadata'],
  };
}

describe('normalizeRelations', () => {
  it('coerces loose JSON and defaults source to curated', () => {
    const out = normalizeRelations([
      { id: 'r1', from: { service: 'a', table: 'x', column: 'id' }, to: { service: 'b', table: 'y', column: 'x_id' }, relationship: 'one_to_many' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].source).toBe('curated');
    expect(out[0].relationship).toBe('one_to_many');
  });

  it('strips db prefix from table names and skips incomplete rows', () => {
    const out = normalizeRelations([
      { from: { service: 'a', table: 'db.x', column: 'id' }, to: { service: 'b', table: 'y', column: 'x_id' } },
      { from: { service: 'a' }, to: { service: 'b', table: 'y' } },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].from.table).toBe('x');
    expect(out[0].id).toContain('a.x.id');
  });
});

describe('relationsForTables', () => {
  const relations = normalizeRelations([
    { id: 'cross', from: { service: 'orders', table: 'order', column: 'customer_id' }, to: { service: 'billing', table: 'customer', column: 'id' }, relationship: 'many_to_one' },
    { id: 'intra', from: { service: 'orders', table: 'order', column: 'status_id' }, to: { service: 'orders', table: 'status', column: 'id' }, relationship: 'many_to_one' },
    { id: 'other', from: { service: 'inventory', table: 'item', column: 'id' }, to: { service: 'inventory', table: 'stock', column: 'item_id' } },
  ]);

  it('returns edges touching referenced tables in the service, cross-service first', () => {
    const edges = relationsForTables(relations, 'orders', ['order']);
    expect(edges).toHaveLength(2);
    expect(edges[0].crossService).toBe(true);
    expect(edges[0].to).toBe('billing.customer.id');
    expect(edges[1].crossService).toBe(false);
  });

  it('returns nothing when no referenced table matches', () => {
    expect(relationsForTables(relations, 'orders', ['unrelated'])).toHaveLength(0);
  });

  it('marks an edge stale when the near-side column is absent from live schema', () => {
    const live = new Map<string, Set<string>>([['order', new Set(['status_id'])]]);
    const edges = relationsForTables(relations, 'orders', ['order'], live);
    const crossEdge = edges.find((e) => e.to.startsWith('billing'));
    expect(crossEdge?.stale).toBe(true);
    expect(crossEdge?.staleReason).toContain('customer_id');
    const intraEdge = edges.find((e) => e.from === 'orders.order.status_id');
    expect(intraEdge?.stale).toBeUndefined();
  });

  it('does not mark stale when live columns are unknown for the table', () => {
    const live = new Map<string, Set<string>>();
    const edges = relationsForTables(relations, 'orders', ['order'], live);
    expect(edges.every((e) => !e.stale)).toBe(true);
  });
});

describe('validateRelations', () => {
  const rels = normalizeRelations([
    { id: 'ok', from: { service: 'a', table: 't1', column: 'b_id' }, to: { service: 'b', table: 't2', column: 'id' } },
    { id: 'badcol', from: { service: 'a', table: 't1', column: 'gone' }, to: { service: 'b', table: 't2', column: 'id' } },
    { id: 'badtable', from: { service: 'a', table: 'nope', column: 'x' }, to: { service: 'b', table: 't2', column: 'id' } },
    { id: 'unknownsvc', from: { service: 'a', table: 't1', column: 'b_id' }, to: { service: 'zzz', table: 't9', column: 'id' } },
  ]);
  const rows = [
    { service: 'a', table: 't1', columns: [{ column: 'b_id' }] },
    { service: 'b', table: 't2', columns: [{ column: 'id' }] },
  ] as any;

  it('classifies endpoints ok / missing_column / missing_table / unknown_service', () => {
    const out = validateRelations(rels, rows);
    const by = Object.fromEntries(out.map((r) => [r.id, r]));
    expect(by.ok.stale).toBe(false);
    expect(by.badcol.fromStatus).toBe('missing_column');
    expect(by.badcol.stale).toBe(true);
    expect(by.badtable.fromStatus).toBe('missing_table');
    expect(by.badtable.stale).toBe(true);
    expect(by.unknownsvc.toStatus).toBe('unknown_service');
    expect(by.unknownsvc.stale).toBe(false);
  });
});

describe('deriveRelationCandidates', () => {
  it('proposes cross-service edges from shared id-like columns', () => {
    const rows = [
      obs('orders', 'order', ['id', 'product_id']),
      obs('catalog', 'product', ['id', 'product_id']),
    ];
    const candidates = deriveRelationCandidates(rows);
    expect(candidates.length).toBeGreaterThan(0);
    const edge = candidates[0];
    expect(edge.source).toBe('derived');
    expect(edge.from.service).not.toBe(edge.to.service);
    expect([edge.from.column, edge.to.column]).toContain('product_id');
  });

  it('ignores plain "id" and single-service columns', () => {
    const rows = [
      obs('a', 't1', ['id', 'name']),
      obs('b', 't2', ['id', 'title']),
    ];
    expect(deriveRelationCandidates(rows)).toHaveLength(0);
  });

  it('does not propose intra-service-only edges', () => {
    const rows = [obs('a', 't1', ['id', 'foo_id']), obs('a', 't2', ['id', 'foo_id'])];
    expect(deriveRelationCandidates(rows)).toHaveLength(0);
  });
});
