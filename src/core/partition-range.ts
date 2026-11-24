import { textUnlessFalsy } from './text-presence.js';

const DATE_LITERAL_RE = /'(?<day>\d{4}-\d{2}-\d{2})(?:[ T][\d:.]+)?'/gu;
const REGEX_SPECIAL_CHARACTERS_RE = /[.*+?^${}()|[\]\\]/gu;
const MS_PER_DAY = 86_400_000;

function escapeRegex(value: string): string {
  return value.replaceAll(REGEX_SPECIAL_CHARACTERS_RE, String.raw`\$&`);
}

function dateLiteralTimestamps(text: string): number[] {
  const timestamps: number[] = [];
  for (const match of text.matchAll(DATE_LITERAL_RE)) {
    const timestamp = Date.parse(`${match.groups?.day}T00:00:00Z`);
    if (Number.isFinite(timestamp)) {
      timestamps.push(timestamp);
    }
  }
  return timestamps;
}

function dateLiteralsForColumn(sql: string, column: string): number[] {
  const predicate = new RegExp(
    `\\b${escapeRegex(column)}\\b\\s*(?:between\\s+('[^']*')\\s+and\\s+('[^']*')|in\\s*\\(([^)]*)\\)|(?:<=|>=|<|>|=)\\s*('[^']*'))`,
    'giu',
  );
  const timestamps: number[] = [];
  for (const match of textUnlessFalsy(sql).matchAll(predicate)) {
    for (const operand of match.slice(1)) {
      if (operand !== undefined && operand !== '') {
        timestamps.push(...dateLiteralTimestamps(operand));
      }
    }
  }
  return timestamps;
}

function hasBoundedPredicate(sql: string, column: string): boolean {
  return new RegExp(`\\b${escapeRegex(column)}\\b\\s*(<=?|=|between\\b|in\\b)`, 'iu').test(textUnlessFalsy(sql));
}

export function rangeWarningForPartitionKey(input: {
  sql: string;
  table: string;
  key: string;
  maxRangeDays: number;
}): string | undefined {
  const { sql, table, key, maxRangeDays } = input;
  const timestamps = dateLiteralsForColumn(sql, key);
  if (timestamps.length === 0) {
    return `range_unverified:${table}.${key}`;
  }
  if (!hasBoundedPredicate(sql, key)) {
    return `unbounded_range:${table}.${key}`;
  }
  const spanDays = Math.round((Math.max(...timestamps) - Math.min(...timestamps)) / MS_PER_DAY);
  return spanDays > maxRangeDays ? `wide_range:${table}.${key}:actual=${spanDays}:max=${maxRangeDays}` : undefined;
}
