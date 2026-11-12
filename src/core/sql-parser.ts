import { createRequire } from 'node:module';

interface SqlParser {
  astify: (sql: string) => unknown;
}

type ParserBuild = { Parser: new () => SqlParser };

const require = createRequire(import.meta.url);
let parser: SqlParser | undefined;
let lastParse: { executedSql: string; statements: readonly unknown[] | undefined } | undefined;

const EXPLAIN_RE = /^[\s(]*(?:explain|describe|desc)\b/i;
const ANALYZE_RE = /\banalyze\b/i;
const EXPLAIN_ANALYZE_RE = /^\s*(?:explain|describe|desc)\s+(?:format\s*=\s*\S+\s+)?analyze\s+(?:format\s*=\s*\S+\s+)?/i;
const SECOND_STATEMENT_RE = /;\s*\S/;
const QUOTES = new Set(["'", '"', '`']);
const LITERAL_FILLER = 'x';

function astifySql(sql: string): unknown {
  parser ??= new (require('node-sql-parser/build/mysql.js') as ParserBuild).Parser();
  return parser.astify(sql);
}

function startsLineComment(sql: string, at: number): boolean {
  if (sql[at] === '#') return true;
  return sql.startsWith('--', at) && (at + 2 === sql.length || /\s/.test(sql[at + 2]));
}

function startsBlockComment(sql: string, at: number): boolean {
  return sql.startsWith('/*', at) && sql[at + 2] !== '!';
}

function closingQuoteAt(sql: string, open: number): number {
  const quote = sql[open];
  let at = open + 1;
  while (at < sql.length) {
    if (sql[at] === '\\' && quote !== '`') at += 2;
    else if (sql[at] === quote && sql[at + 1] === quote) at += 2;
    else if (sql[at] === quote) return at;
    else at += 1;
  }
  return sql.length;
}

export function maskCommentsAndLiterals(sql: string): string {
  let out = '';
  let at = 0;
  while (at < sql.length) {
    if (startsLineComment(sql, at)) {
      const newline = sql.indexOf('\n', at);
      const end = newline < 0 ? sql.length : newline;
      out += ' '.repeat(end - at);
      at = end;
    } else if (startsBlockComment(sql, at)) {
      const close = sql.indexOf('*/', at + 2);
      const end = close < 0 ? sql.length : close + 2;
      out += ' '.repeat(end - at);
      at = end;
    } else if (QUOTES.has(sql[at])) {
      const close = closingQuoteAt(sql, at);
      out += sql[at] + LITERAL_FILLER.repeat(Math.min(close, sql.length) - at - 1) + (close < sql.length ? sql[close] : '');
      at = close + 1;
    } else {
      out += sql[at];
      at += 1;
    }
  }
  return out;
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
  return prefix ? sql.slice(prefix[0].length) : undefined;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

function parseStatements(executedSql: string): readonly unknown[] | undefined {
  try {
    const ast = astifySql(executedSql);
    return deepFreeze(Array.isArray(ast) ? ast : [ast]);
  } catch {
    return undefined;
  }
}

export function parseExecutedStatements(sql: string): readonly unknown[] | undefined {
  const executedSql = explainAnalyzeTarget(sql) ?? sql;
  if (lastParse?.executedSql !== executedSql) lastParse = { executedSql, statements: parseStatements(executedSql) };
  return lastParse.statements;
}
