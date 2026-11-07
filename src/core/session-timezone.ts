import { badInput } from './error-classification.js';
import { str } from './strings.js';

export const DEFAULT_SESSION_TIME_ZONE = '+00:00';

const OFFSET_PATTERN = /^[+-](?:[01]\d|2[0-3]):[0-5]\d$/;
const NAMED_ZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+\-/]*$/;

export function isUtcOffset(timeZone: string): boolean {
  return OFFSET_PATTERN.test(timeZone);
}

export function normalizeTimeZone(value?: string): string {
  const raw = str(value).trim();
  if (!raw) return DEFAULT_SESSION_TIME_ZONE;
  const lower = raw.toLowerCase();
  if (lower === 'utc' || lower === 'z' || lower === 'gmt') return DEFAULT_SESSION_TIME_ZONE;
  if (isUtcOffset(raw)) return raw;
  const signedHour = raw.match(/^([+-])(\d{1,2})$/);
  if (signedHour) {
    const sign = signedHour[1];
    const hour = Number(signedHour[2]);
    if (hour <= 23) return `${sign}${String(hour).padStart(2, '0')}:00`;
  }
  if (NAMED_ZONE_PATTERN.test(raw)) return raw;
  throw badInput(`invalid --tz '${raw}'. Expected an offset like +00:00 / -05:30, or an IANA zone name like Europe/Berlin.`);
}

export function resolveSessionTimeZone(input: {
  override?: string;
  datasourceHint?: string;
  configDefault?: string;
}): string {
  const candidate = [input.override, input.datasourceHint, input.configDefault]
    .map((value) => str(value).trim())
    .find((value) => value.length > 0);
  return normalizeTimeZone(candidate);
}
