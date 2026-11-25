import { describe, expect, it } from 'vitest';
import { pluckPath } from '../src/core/dot-path.js';

describe('plucking a dot path', () => {
  const obj = {
    result: {
      columns: ['id', 'name'],
      rows: [[1, 'a'], [2, 'b']],
    },
    meta: {
      schemaContext: {
        tables: {
          event: {
            indexes: [{ name: 'PRIMARY', columns: ['id'] }, { name: 'idx_name', columns: ['name'] }],
          },
        },
      },
    },
  };

  it('returns the full object when path is empty', () => {
    expect(pluckPath(obj, '')).toBe(obj);
  });

  it('returns the value at a nested dot path', () => {
    expect(pluckPath(obj, 'result.columns')).toStrictEqual(['id', 'name']);
    expect(pluckPath(obj, 'meta.schemaContext.tables.event.indexes')).toHaveLength(2);
  });

  it('returns the element at a bracket index', () => {
    expect(pluckPath(obj, 'result.rows[0]')).toStrictEqual([1, 'a']);
    expect(pluckPath(obj, 'result.rows[1]')).toStrictEqual([2, 'b']);
    expect(pluckPath(obj, 'meta.schemaContext.tables.event.indexes[0].name')).toBe('PRIMARY');
  });

  it('returns undefined for missing paths', () => {
    expect(pluckPath(obj, 'result.missing')).toBeUndefined();
    expect(pluckPath(obj, 'result.rows[99]')).toBeUndefined();
    expect(pluckPath(obj, 'meta.schemaContext.tables.bogus.indexes')).toBeUndefined();
  });

  it('returns undefined when traversing through null', () => {
    expect(pluckPath({ a: null }, 'a.b.c')).toBeUndefined();
  });
});
