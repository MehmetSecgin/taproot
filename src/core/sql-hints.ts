import { str } from './strings.js';

const RESERVED_ALIAS_WORDS = new Set([
  'rows',
  'row',
  'rank',
  'groups',
  'group',
  'order',
  'system',
  'window',
  'over',
  'recursive',
  'lead',
  'lag',
  'dense_rank',
  'row_number',
  'first_value',
  'last_value',
  'nth_value',
  'ntile',
  'percent_rank',
  'cume_dist',
  'range',
  'usage',
  'lateral',
]);

const ALIAS_PATTERN = /(?:\bas\s+|[)\w]\s+)`?([a-z_][a-z0-9_]*)`?\s*(?=,|\bfrom\b|$)/gi;

export function reservedAliasHint(sql: string): string | null {
  const text = str(sql);
  const offenders = new Set<string>();
  let match: RegExpExecArray | null;
  ALIAS_PATTERN.lastIndex = 0;
  while ((match = ALIAS_PATTERN.exec(text)) !== null) {
    const candidate = match[1];
    const quoted = match[0].includes('`');
    if (quoted) continue;
    if (RESERVED_ALIAS_WORDS.has(candidate.toLowerCase())) offenders.add(candidate);
  }
  if (!offenders.size) return null;
  const list = [...offenders].map((word) => `\`${word}\``).join(', ');
  return `'${[...offenders].join("', '")}' is a reserved word used as a column alias; quote it with backticks (${list}) or rename the alias.`;
}

export function enrichSqlSyntaxError(message: string, sql: string): string {
  const text = str(message);
  if (!/you have an error in your sql syntax|syntax error/i.test(text)) return text;
  const hint = reservedAliasHint(sql);
  if (!hint) return text;
  return `${text} (taproot hint: ${hint})`;
}
