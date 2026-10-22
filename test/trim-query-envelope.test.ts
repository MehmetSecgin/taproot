import { describe, expect, it } from 'vitest';
import { trimQueryJsonEnvelope } from '../src/core/output.js';

describe('trimQueryJsonEnvelope', () => {
  it('drops empty warnings array from data', () => {
    const out = trimQueryJsonEnvelope({
      ok: true,
      data: { columns: [], rows: [], warnings: [] },
      meta: {},
    });
    expect('warnings' in (out.data as Record<string, unknown>)).toBe(false);
  });

  it('drops schemaContext when every sub-map is empty', () => {
    const out = trimQueryJsonEnvelope({
      ok: true,
      data: {},
      meta: { schemaContext: { tables: {}, services: {}, messages: {}, enums: {} } },
    });
    expect('schemaContext' in (out.meta as Record<string, unknown>)).toBe(false);
  });

  it('keeps schemaContext when any sub-map has entries', () => {
    const out = trimQueryJsonEnvelope({
      ok: true,
      data: {},
      meta: { schemaContext: { tables: { event: {} }, services: {}, messages: {}, enums: {} } },
    });
    expect((out.meta as Record<string, unknown>).schemaContext).toBeDefined();
  });

  it('is a no-op when there is nothing to trim', () => {
    const out = trimQueryJsonEnvelope({ ok: true, data: { columns: ['a'], rows: [[1]] }, meta: { sessionId: 's1' } });
    expect(out.data).toEqual({ columns: ['a'], rows: [[1]] });
    expect(out.meta).toEqual({ sessionId: 's1' });
  });
});
