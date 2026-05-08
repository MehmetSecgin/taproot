import { afterEach, describe, expect, it } from 'vitest';
import { renderTable, renderTableSmart, renderTableSummary } from '../src/core/output.js';

const ORIGINAL_ENV = process.env.TAPROOT_DATETIME_FORMAT;

afterEach(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.TAPROOT_DATETIME_FORMAT;
  else process.env.TAPROOT_DATETIME_FORMAT = ORIGINAL_ENV;
});

describe('renderTable value formatting', () => {
  it('stringifies JSON object cells instead of [object Object]', () => {
    const out = renderTable([{ id: 1, payload: { score: { home: 1, away: 0 } } }]);
    expect(out).not.toContain('[object Object]');
    expect(out).toContain('"score"');
    expect(out).toContain('"home":1');
  });

  it('renders Date columns as ISO-8601 by default', () => {
    const date = new Date('2026-05-08T09:22:48.000Z');
    const out = renderTable([{ ts: date }]);
    expect(out).toContain('2026-05-08T09:22:48.000Z');
    expect(out).not.toContain('GMT');
  });

  it('renders Date columns as JS string when format=js', () => {
    process.env.TAPROOT_DATETIME_FORMAT = 'js';
    const date = new Date('2026-05-08T09:22:48.000Z');
    const out = renderTable([{ ts: date }]);
    expect(out).toContain(date.toString());
  });

  it('renders Date columns as epoch ms when format=epoch', () => {
    process.env.TAPROOT_DATETIME_FORMAT = 'epoch';
    const date = new Date('2026-05-08T09:22:48.000Z');
    const out = renderTable([{ ts: date }]);
    expect(out).toContain(String(date.getTime()));
  });

  it('handles arrays of objects via JSON stringify', () => {
    const out = renderTable([{ tags: [{ k: 1 }, { k: 2 }] }]);
    expect(out).not.toContain('[object Object]');
    expect(out).toContain('"k":1');
    expect(out).toContain('"k":2');
  });

  it('handles bigint and Buffer cells', () => {
    const out = renderTable([{ big: BigInt('9007199254740993'), bin: Buffer.from('hi') }]);
    expect(out).toContain('9007199254740993');
    expect(out).toContain(Buffer.from('hi').toString('base64'));
  });
});

describe('renderTableSmart big-result handling', () => {
  function makeRows(count: number, payloadSize = 200): Array<Record<string, unknown>> {
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < count; i += 1) {
      rows.push({ id: i, group: i % 3, payload: 'x'.repeat(payloadSize) });
    }
    return rows;
  }

  it('returns full table when output is below threshold', () => {
    const rows = makeRows(3);
    const smart = renderTableSmart(rows);
    expect(smart).toBe(renderTable(rows));
    expect(smart).not.toContain('summarized');
  });

  it('summarizes when rendered output exceeds threshold', () => {
    const rows = makeRows(500);
    const smart = renderTableSmart(rows);
    expect(smart).toContain('summarized');
    expect(smart).toContain(`Rows: ${rows.length}`);
    expect(smart).toContain('Distinct values per column');
    expect(smart).toContain('First 10 rows');
    expect(smart.length).toBeLessThan(renderTable(rows).length);
  });

  it('honors --full by returning full table even when oversized', () => {
    const rows = makeRows(500);
    const smart = renderTableSmart(rows, { full: true });
    expect(smart).toBe(renderTable(rows));
    expect(smart).not.toContain('summarized');
  });

  it('respects custom thresholdBytes', () => {
    const rows = makeRows(5, 50);
    const smart = renderTableSmart(rows, { thresholdBytes: 50 });
    expect(smart).toContain('summarized');
  });

  it('renderTableSummary reports accurate distinct counts', () => {
    const rows = [
      { kind: 'a', value: 1 },
      { kind: 'a', value: 2 },
      { kind: 'b', value: 2 },
      { kind: 'b', value: 3 },
    ];
    const summary = renderTableSummary(rows);
    expect(summary).toContain('Rows: 4');
    expect(summary).toContain('Distinct values per column');
    const expectedDistinctTable = renderTable([
      { column: 'kind', distinct: 2 },
      { column: 'value', distinct: 3 },
    ]);
    expect(summary).toContain(expectedDistinctTable);
  });

  it('renderTableSummary on empty rows returns no-rows marker', () => {
    expect(renderTableSummary([])).toBe('Rows: 0\n(no rows)');
  });
});
