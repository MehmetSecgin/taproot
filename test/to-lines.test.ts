import { describe, expect, it } from 'vitest';
import { envelopeToLines } from '../src/core/output.js';

describe('converting an envelope to lines', () => {
  it('prints a header with ok and columns, then one line per row', () => {
    // arrange
    const envelope = { ok: true, data: { columns: ['id', 'name'], rows: [[1, 'a'], [2, 'b']], rowsForm: 'array' }, meta: { requestId: 'r1' } };
    // act
    const lines = envelopeToLines(envelope);
    // assert
    expect(lines).toStrictEqual([{ ok: true, columns: ['id', 'name'] }, [1, 'a'], [2, 'b']]);
  });

  it('keeps warnings in the header', () => {
    const envelope = { ok: true, data: { columns: ['id'], rows: [[1]], warnings: ['partition_scan_bypassed'] } };
    expect(envelopeToLines(envelope)[0]).toStrictEqual({ ok: true, columns: ['id'], warnings: ['partition_scan_bypassed'] });
  });

  it('marks the header when the rows were cut', () => {
    // arrange
    const envelope = { ok: true, data: { columns: ['id'], rows: [[1]], truncated: true } };

    // act
    const [header] = envelopeToLines(envelope);

    // assert
    expect(header).toStrictEqual({ ok: true, columns: ['id'], truncated: true });
  });

  it('prints only the header for an empty result', () => {
    expect(envelopeToLines({ ok: true, data: { columns: ['id'], rows: [] } })).toStrictEqual([{ ok: true, columns: ['id'] }]);
  });

  it('prints one line per item of an array result', () => {
    const envelope = { ok: true, data: [{ name: 'qa-orders' }, { name: 'qa-billing' }] };
    expect(envelopeToLines(envelope)).toStrictEqual([{ ok: true }, { name: 'qa-orders' }, { name: 'qa-billing' }]);
  });

  it('prints one line per item of a plucked array', () => {
    expect(envelopeToLines([[1, 'a'], [2, 'b']])).toStrictEqual([[1, 'a'], [2, 'b']]);
  });

  it('keeps a non-tabular value on one line', () => {
    const envelope = { ok: true, data: { readiness: 'ok' } };
    expect(envelopeToLines(envelope)).toStrictEqual([envelope]);
    expect(envelopeToLines('qa-orders')).toStrictEqual(['qa-orders']);
  });
});
