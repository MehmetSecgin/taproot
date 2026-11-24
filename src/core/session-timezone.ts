import { badInput } from './taproot-error.js';
import { textUnlessFalsy } from './text-presence.js';

export const DEFAULT_SESSION_TIME_ZONE = '+00:00';

const OFFSET_PATTERN = /^[+-](?:[01]\d|2[0-3]):[0-5]\d$/u;
const NAMED_ZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+\-/]*$/u;
const SIGNED_HOUR_PATTERN = /^(?<sign>[+-])(?<hour>\d{1,2})$/u;
const UTC_ALIASES = new Set(['utc', 'z', 'gmt']);
const LAST_HOUR_OF_DAY = 23;

export function isUtcOffset(timeZone: string): boolean {
  return OFFSET_PATTERN.test(timeZone);
}

function toUtcOffset(raw: string): string | undefined {
  if (isUtcOffset(raw)) {
    return raw;
  }
  const { sign, hour } = SIGNED_HOUR_PATTERN.exec(raw)?.groups ?? {};
  if (sign === undefined || hour === undefined || Number(hour) > LAST_HOUR_OF_DAY) {
    return undefined;
  }
  return `${sign}${hour.padStart(2, '0')}:00`;
}

export function normalizeTimeZone(value?: string): string {
  const raw = textUnlessFalsy(value).trim();
  if (raw === '' || UTC_ALIASES.has(raw.toLowerCase())) {
    return DEFAULT_SESSION_TIME_ZONE;
  }
  const utcOffset = toUtcOffset(raw);
  if (utcOffset !== undefined) {
    return utcOffset;
  }
  if (NAMED_ZONE_PATTERN.test(raw)) {
    return raw;
  }
  throw badInput(`invalid --tz '${raw}'. Expected an offset like +00:00 / -05:30, or an IANA zone name like Europe/Berlin.`);
}

export function resolveSessionTimeZone(input: {
  override?: string;
  datasourceHint?: string;
  configDefault?: string;
}): string {
  const candidate = [input.override, input.datasourceHint, input.configDefault]
    .map((value) => textUnlessFalsy(value).trim())
    .find((value) => value.length > 0);
  return normalizeTimeZone(candidate);
}
