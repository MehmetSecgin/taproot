import { describe, expect, it } from 'vitest';
import { DEFAULT_SESSION_TIME_ZONE, normalizeTimeZone, resolveSessionTimeZone } from '../src/core/session-timezone.js';

describe('normalizeTimeZone', () => {
  it('defaults to UTC when empty', () => {
    expect(normalizeTimeZone(undefined)).toBe('+00:00');
    expect(normalizeTimeZone('')).toBe(DEFAULT_SESSION_TIME_ZONE);
  });

  it('maps UTC aliases to the canonical offset', () => {
    expect(normalizeTimeZone('UTC')).toBe('+00:00');
    expect(normalizeTimeZone('utc')).toBe('+00:00');
    expect(normalizeTimeZone('Z')).toBe('+00:00');
    expect(normalizeTimeZone('GMT')).toBe('+00:00');
  });

  it('accepts explicit offsets', () => {
    expect(normalizeTimeZone('+05:30')).toBe('+05:30');
    expect(normalizeTimeZone('-08:00')).toBe('-08:00');
  });

  it('normalizes signed-hour shorthand', () => {
    expect(normalizeTimeZone('+2')).toBe('+02:00');
    expect(normalizeTimeZone('-5')).toBe('-05:00');
  });

  it('passes through IANA zone names', () => {
    expect(normalizeTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
    expect(normalizeTimeZone('America/New_York')).toBe('America/New_York');
  });

  it('rejects invalid offsets and injection attempts', () => {
    expect(() => normalizeTimeZone('+99:99')).toThrow(/BAD_INPUT/);
    expect(() => normalizeTimeZone("'; DROP TABLE x; --")).toThrow(/BAD_INPUT/);
    expect(() => normalizeTimeZone('not a zone')).toThrow(/BAD_INPUT/);
  });
});

describe('resolveSessionTimeZone', () => {
  it('prefers override over datasource hint over config default', () => {
    expect(
      resolveSessionTimeZone({ override: '+01:00', datasourceHint: '+02:00', configDefault: '+03:00' }),
    ).toBe('+01:00');
    expect(resolveSessionTimeZone({ datasourceHint: '+02:00', configDefault: '+03:00' })).toBe('+02:00');
    expect(resolveSessionTimeZone({ configDefault: '+03:00' })).toBe('+03:00');
  });

  it('falls back to UTC when nothing is set', () => {
    expect(resolveSessionTimeZone({})).toBe('+00:00');
    expect(resolveSessionTimeZone({ override: '   ' })).toBe('+00:00');
  });
});
