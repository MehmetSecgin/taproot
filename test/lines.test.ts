import { describe, expect, it } from 'vitest';
import { toLines } from '../src/core/output.js';

describe('toLines', () => {
  it('prints a header with ok and columns, then one line per row', () => {
    // arrange
    const envelope = { ok: true, data: { columns: ['id', 'name'], rows: [[1, 'a'], [2, 'b']], rowsForm: 'array' }, meta: { requestId: 'r1' } };
    // act
    const lines = toLines(envelope);
    // assert
    expect(lines).toEqual([{ ok: true, columns: ['id', 'name'] }, [1, 'a'], [2, 'b']]);
  });

  it('keeps warnings in the header', () => {
    const envelope = { ok: true, data: { columns: ['id'], rows: [[1]], warnings: ['partition_scan_bypassed'] } };
    expect(toLines(envelope)[0]).toEqual({ ok: true, columns: ['id'], warnings: ['partition_scan_bypassed'] });
  });

  it('prints only the header for an empty result', () => {
    expect(toLines({ ok: true, data: { columns: ['id'], rows: [] } })).toEqual([{ ok: true, columns: ['id'] }]);
  });

  it('prints one line per item of an array result', () => {
    const envelope = { ok: true, data: [{ name: 'qa-orders' }, { name: 'qa-billing' }] };
    expect(toLines(envelope)).toEqual([{ ok: true }, { name: 'qa-orders' }, { name: 'qa-billing' }]);
  });

  it('prints one line per item of a plucked array', () => {
    expect(toLines([[1, 'a'], [2, 'b']])).toEqual([[1, 'a'], [2, 'b']]);
  });

  it('keeps a non-tabular value on one line', () => {
    const envelope = { ok: true, data: { readiness: 'ok' } };
    expect(toLines(envelope)).toEqual([envelope]);
    expect(toLines('qa-orders')).toEqual(['qa-orders']);
  });
});
