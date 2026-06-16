import { describe, expect, it } from 'vitest';
import { rowToObject } from '../src/core/output.js';

describe('rowToObject', () => {
  const columns = ['id', 'name'];

  it('zips a positional array row with columns (daemon array form)', () => {
    expect(rowToObject(columns, [1, 'foo'])).toEqual({ id: 1, name: 'foo' });
  });

  it('passes through an object row keyed by column (rows-object form)', () => {
    expect(rowToObject(columns, { id: 2, name: 'bar', extra: 'x' })).toEqual({ id: 2, name: 'bar' });
  });

  it('fills missing positional cells with undefined', () => {
    expect(rowToObject(columns, [3])).toEqual({ id: 3, name: undefined });
  });

  it('tolerates null/non-object rows', () => {
    expect(rowToObject(columns, null)).toEqual({ id: undefined, name: undefined });
  });
});
