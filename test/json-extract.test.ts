import { describe, expect, it } from 'vitest';
import { applyJsonExtract, parseJsonExtractSpecs } from '../src/core/json-extract.js';

describe('parseJsonExtractSpecs', () => {
  it('parses column:dotpath specs', () => {
    expect(parseJsonExtractSpecs(['payload:order.id'])).toEqual([
      { column: 'payload', path: 'order.id', alias: 'payload.order.id' },
    ]);
  });

  it('returns empty for undefined or empty entries', () => {
    expect(parseJsonExtractSpecs(undefined)).toEqual([]);
    expect(parseJsonExtractSpecs(['  '])).toEqual([]);
  });

  it('rejects malformed specs', () => {
    expect(() => parseJsonExtractSpecs(['payload'])).toThrow(/BAD_INPUT/);
    expect(() => parseJsonExtractSpecs([':order.id'])).toThrow(/BAD_INPUT/);
    expect(() => parseJsonExtractSpecs(['payload:'])).toThrow(/BAD_INPUT/);
  });
});

describe('applyJsonExtract', () => {
  const specs = parseJsonExtractSpecs(['payload:order.id']);

  it('extracts a value from a JSON string column into a derived column', () => {
    const result = applyJsonExtract(
      ['id', 'payload'],
      [
        { id: 1, payload: '{"order":{"id":"A1"}}' },
        { id: 2, payload: '{"order":{"id":"B2"}}' },
      ],
      specs,
    );
    expect(result.columns).toEqual(['id', 'payload', 'payload.order.id']);
    expect(result.rows[0]['payload.order.id']).toBe('A1');
    expect(result.rows[1]['payload.order.id']).toBe('B2');
  });

  it('parses already-object columns and missing paths yield null', () => {
    const result = applyJsonExtract(
      ['payload'],
      [{ payload: { order: { id: 'C3' } } }, { payload: '{"order":{}}' }, { payload: null }],
      specs,
    );
    expect(result.rows[0]['payload.order.id']).toBe('C3');
    expect(result.rows[1]['payload.order.id']).toBeNull();
    expect(result.rows[2]['payload.order.id']).toBeNull();
  });

  it('yields null for unparseable JSON instead of throwing', () => {
    const result = applyJsonExtract(['payload'], [{ payload: 'not json' }], specs);
    expect(result.rows[0]['payload.order.id']).toBeNull();
  });

  it('throws when the referenced column is absent', () => {
    expect(() => applyJsonExtract(['id'], [{ id: 1 }], specs)).toThrow(/BAD_INPUT/);
  });

  it('is a no-op when there are no specs', () => {
    const rows = [{ id: 1 }];
    const result = applyJsonExtract(['id'], rows, []);
    expect(result.columns).toEqual(['id']);
    expect(result.rows).toBe(rows);
  });
});
