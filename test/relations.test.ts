import { describe, expect, it } from 'vitest';
import { normalizeRelations } from '../src/core/relations.js';

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
