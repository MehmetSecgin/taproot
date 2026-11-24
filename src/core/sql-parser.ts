import { createRequire } from 'node:module';
import { textUnlessFalsy } from './text-presence.js';
import { deepFreeze } from './deep-freeze.js';

type SqlParser = {
  astify: (sql: string) => unknown;
};

type ParserBuild = { Parser: new () => SqlParser };

type ParsedStatements = { executedSql: string; statements: readonly unknown[] | undefined };

type ParserState = { parser?: SqlParser; lastParsedStatements?: ParsedStatements };

type MaskedSpan = { text: string; end: number };

const require = createRequire(import.meta.url);
const parserState: ParserState = {};

const EXPLAIN_RE = /^[\s(]*(?:explain|describe|desc)\b/iu;
const ANALYZE_RE = /\banalyze\b/iu;
const EXPLAIN_ANALYZE_RE = /^\s*(?:explain|describe|desc)\s+(?:format\s*=\s*\S+\s+)?analyze\s+(?:format\s*=\s*\S+\s+)?/iu;
const SECOND_STATEMENT_RE = /;\s*\S/u;
const QUOTES = new Set(["'", '"', '`']);
const DASH_COMMENT_SPACE_RE = /[ \t\n\v\f\r]/u;
const LITERAL_FILLER = 'x';
const WHITESPACE_RUN_RE = /\s+/gu;
const SCHEMA_METADATA_PREFIX_RE =
  /^(?:show\s+(?:create\s+(?:table|view)\b|tables\b|(?:full\s+)?(?:columns|fields)\b|(?:index(?:es)?|keys)\b)|describe\b|desc\b|explain\b)/u;

function isParserBuild(build: unknown): build is ParserBuild {
  return typeof build === 'object' && build !== null && 'Parser' in build && typeof build.Parser === 'function';
}

function createParser(): SqlParser {
  const build: unknown = require('node-sql-parser/build/mysql.js');
  if (!isParserBuild(build)) {
    throw new Error('node-sql-parser mysql build does not export Parser');
  }
  return new build.Parser();
}

function astifySql(sql: string): unknown {
  parserState.parser ??= createParser();
  return parserState.parser.astify(sql);
}

function startsLineComment(sql: string, at: number): boolean {
  if (sql[at] === '#') {
    return true;
  }
  return sql.startsWith('--', at) && (at + 2 === sql.length || DASH_COMMENT_SPACE_RE.test(sql[at + 2]));
}

function startsBlockComment(sql: string, at: number): boolean {
  return sql.startsWith('/*', at) && sql[at + 2] !== '!';
}

function closingQuoteAt(sql: string, open: number): number {
  const quote = sql[open];
  let at = open + 1;
  while (at < sql.length) {
    if (sql[at] === '\\' && quote !== '`') {
      at += 2;
    } else if (sql[at] === quote && sql[at + 1] === quote) {
      at += 2;
    } else if (sql[at] === quote) {
      return at;
    } else {
      at += 1;
    }
  }
  return sql.length;
}

function commentEndAt(sql: string, at: number): number | undefined {
  if (startsLineComment(sql, at)) {
    const newline = sql.indexOf('\n', at);
    return newline === -1 ? sql.length : newline;
  }
  if (startsBlockComment(sql, at)) {
    const close = sql.indexOf('*/', at + 2);
    return close === -1 ? sql.length : close + 2;
  }
  return undefined;
}

function maskedQuotedLiteral(sql: string, open: number, maskLiterals: boolean): MaskedSpan {
  const close = closingQuoteAt(sql, open);
  if (!maskLiterals) {
    return { text: sql.slice(open, close + 1), end: close + 1 };
  }
  const filler = LITERAL_FILLER.repeat(Math.min(close, sql.length) - open - 1);
  const closingQuote = close < sql.length ? sql[close] : '';
  return { text: sql[open] + filler + closingQuote, end: close + 1 };
}

function maskedSpanAt(sql: string, at: number, maskLiterals: boolean): MaskedSpan {
  const commentEnd = commentEndAt(sql, at);
  if (commentEnd !== undefined) {
    return { text: ' '.repeat(commentEnd - at), end: commentEnd };
  }
  if (QUOTES.has(sql[at])) {
    return maskedQuotedLiteral(sql, at, maskLiterals);
  }
  return { text: sql[at], end: at + 1 };
}

function maskSql(sql: string, maskLiterals: boolean): string {
  let masked = '';
  let at = 0;
  while (at < sql.length) {
    const span = maskedSpanAt(sql, at, maskLiterals);
    masked += span.text;
    at = span.end;
  }
  return masked;
}

export function maskCommentsAndLiterals(sql: string): string {
  return maskSql(sql, true);
}

export function maskComments(sql: string): string {
  return maskSql(sql, false);
}

export function hasSecondStatement(sql: string): boolean {
  return SECOND_STATEMENT_RE.test(maskCommentsAndLiterals(sql));
}

export function isExplainAnalyze(sql: string): boolean {
  const maskedSql = maskCommentsAndLiterals(sql);
  return EXPLAIN_RE.test(maskedSql) && ANALYZE_RE.test(maskedSql);
}

export function explainAnalyzeTarget(sql: string): string | undefined {
  const prefix = EXPLAIN_ANALYZE_RE.exec(maskCommentsAndLiterals(sql));
  return prefix === null ? undefined : sql.slice(prefix[0].length);
}

export function isSchemaMetadataQuery(sql: string): boolean {
  if (isExplainAnalyze(sql)) {
    return false;
  }
  const normalizedSql = textUnlessFalsy(sql).trim().replaceAll(WHITESPACE_RUN_RE, ' ').toLowerCase();
  return SCHEMA_METADATA_PREFIX_RE.test(normalizedSql);
}

function parseStatements(executedSql: string): readonly unknown[] | undefined {
  try {
    const ast: unknown = astifySql(executedSql);
    const statements: unknown[] = Array.isArray(ast) ? ast : [ast];
    return deepFreeze(statements);
  } catch {
    return undefined;
  }
}

export function parseExecutedStatements(sql: string): readonly unknown[] | undefined {
  const executedSql = explainAnalyzeTarget(sql) ?? sql;
  if (parserState.lastParsedStatements?.executedSql !== executedSql) {
    parserState.lastParsedStatements = { executedSql, statements: parseStatements(executedSql) };
  }
  return parserState.lastParsedStatements.statements;
}
