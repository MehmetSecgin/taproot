import { classifyError } from './error-classification.js';
import { textUnlessFalsy } from './text-presence.js';

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

const ALIAS_PATTERN = /(?:\bas\s+|[)\w]\s+)`?(?<alias>[a-z_][a-z0-9_]*)`?\s*(?=,|\bfrom\b|$)/giu;
const SYNTAX_ERROR_PATTERN = /you have an error in your sql syntax|syntax error/iu;

function unquotedReservedAliases(sql: string): Set<string> {
  const reservedAliases = new Set<string>();
  for (const match of sql.matchAll(ALIAS_PATTERN)) {
    const alias = match.groups?.alias;
    const isBacktickQuoted = match[0].includes('`');
    if (alias !== undefined && !isBacktickQuoted && RESERVED_ALIAS_WORDS.has(alias.toLowerCase())) {
      reservedAliases.add(alias);
    }
  }
  return reservedAliases;
}

export function reservedAliasHint(sql: string): string | null {
  const offenders = [...unquotedReservedAliases(textUnlessFalsy(sql))];
  if (offenders.length === 0) {
    return null;
  }
  const quotedList = offenders.map((word) => `\`${word}\``).join(', ');
  return `'${offenders.join("', '")}' is a reserved word used as a column alias; quote it with backticks (${quotedList}) or rename the alias.`;
}

export function enrichSqlSyntaxError(message: string, sql: string): string {
  const text = textUnlessFalsy(message);
  if (!SYNTAX_ERROR_PATTERN.test(text)) {
    return text;
  }
  const hint = reservedAliasHint(sql);
  if (hint === null) {
    return text;
  }
  return `${text} (taproot hint: ${hint})`;
}

export function enrichResourceLimitError(message: string): string {
  const text = textUnlessFalsy(message);
  if (classifyError(text) !== 'RESOURCE_LIMIT') {
    return text;
  }
  return (
    `${text} (taproot hint: the database resource group rejected this scan; ` +
    `narrow it with a predicate on the partition column or an indexed id range, and add LIMIT, before retrying)`
  );
}
