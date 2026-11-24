import { describe, expect, it } from 'vitest';
import { trimQueryJsonEnvelope } from '../src/cli/query-present.js';

describe('trimming a query envelope', () => {
  it('drops empty warnings array from data', () => {
    const out = trimQueryJsonEnvelope({
      ok: true,
      data: { columns: [], rows: [], warnings: [] },
      meta: {},
    });
    expect(out.data).not.toHaveProperty('warnings');
  });

  it('drops schemaContext when tables is empty', () => {
    const out = trimQueryJsonEnvelope({
      ok: true,
      data: {},
      meta: { schemaContext: { tables: {} } },
    });
    expect(out.meta).not.toHaveProperty('schemaContext');
  });

  it('keeps schemaContext when tables has entries', () => {
    const out = trimQueryJsonEnvelope({
      ok: true,
      data: {},
      meta: { schemaContext: { tables: { event: {} } } },
    });
    expect((out.meta as Record<string, unknown>).schemaContext).toBeDefined();
  });

  it('is a no-op when there is nothing to trim', () => {
    const out = trimQueryJsonEnvelope({ ok: true, data: { columns: ['a'], rows: [[1]] }, meta: { sessionId: 's1' } });
    expect(out.data).toStrictEqual({ columns: ['a'], rows: [[1]] });
    expect(out.meta).toStrictEqual({ sessionId: 's1' });
  });
});
