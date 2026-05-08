import { afterEach, describe, expect, it } from 'vitest';
import { renderTable } from '../src/core/output.js';

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
