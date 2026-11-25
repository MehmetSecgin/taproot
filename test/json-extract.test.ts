import { describe, expect, it } from 'vitest';
import { applyJsonExtract, parseJsonExtractSpecs } from '../src/core/json-extract.js';

describe('parsing --json-extract specs', () => {
  it('splits each spec into its column and its dot path', () => {
    expect(parseJsonExtractSpecs(['payload:order.id'])).toStrictEqual([
      { column: 'payload', path: 'order.id', outputColumn: 'payload.order.id' },
    ]);
  });

  it('returns empty for undefined or empty entries', () => {
    expect(parseJsonExtractSpecs()).toStrictEqual([]);
    expect(parseJsonExtractSpecs(['  '])).toStrictEqual([]);
  });

  it('rejects a spec without a column or a path, naming the spec', () => {
    expect(() => parseJsonExtractSpecs(['payload'])).toThrow(/BAD_INPUT/u);
    expect(() => parseJsonExtractSpecs([':order.id'])).toThrow(/BAD_INPUT/u);
    expect(() => parseJsonExtractSpecs(['payload:'])).toThrow(/BAD_INPUT/u);
  });
});

describe('applying --json-extract specs', () => {
  const specs = parseJsonExtractSpecs(['payload:order.id']);

  it('extracts a value from a JSON string column into a derived column', () => {
    const result = applyJsonExtract(
      ['id', 'payload'],
      [
        [1, '{"order":{"id":"A1"}}'],
        [2, '{"order":{"id":"B2"}}'],
      ],
      specs,
    );
    expect(result.columns).toStrictEqual(['id', 'payload', 'payload.order.id']);
    expect(result.rows).toStrictEqual([
      [1, '{"order":{"id":"A1"}}', 'A1'],
      [2, '{"order":{"id":"B2"}}', 'B2'],
    ]);
  });

  it('parses already-object columns and missing paths yield null', () => {
    const result = applyJsonExtract(['payload'], [[{ order: { id: 'C3' } }], ['{"order":{}}'], [null]], specs);
    expect(result.rows.map((row) => row[1])).toStrictEqual(['C3', null, null]);
  });

  it('yields null for unparseable JSON instead of throwing', () => {
    const result = applyJsonExtract(['payload'], [['not json']], specs);
    expect(result.rows[0][1]).toBeNull();
  });

  it('keeps every column when two share a name', () => {
    const result = applyJsonExtract(['id', 'id', 'payload'], [[1, 2, '{"order":{"id":"D4"}}']], specs);
    expect(result.columns).toStrictEqual(['id', 'id', 'payload', 'payload.order.id']);
    expect(result.rows).toStrictEqual([[1, 2, '{"order":{"id":"D4"}}', 'D4']]);
  });

  it('throws when the referenced column is absent', () => {
    expect(() => applyJsonExtract(['id'], [[1]], specs)).toThrow(/BAD_INPUT/u);
  });

  it('is a no-op when there are no specs', () => {
    const rows = [[1]];
    const result = applyJsonExtract(['id'], rows, []);
    expect(result.columns).toStrictEqual(['id']);
    expect(result.rows).toBe(rows);
  });
});
