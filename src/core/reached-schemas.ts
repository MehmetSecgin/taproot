import { propertyOf } from './object-property.js';
import { parseExecutedStatements } from './sql-parser.js';
import { TokenCursor, tokenize } from './sql-token-cursor.js';
import { EXPLAIN_KEYWORDS } from './sql-keywords.js';

const LEADING_KEYWORDS_TO_PARSE = new Set(['select', 'with', 'insert', 'update', 'delete', 'replace', '(']);
const PARSED_AST_TYPES = new Set<unknown>(['select', 'insert', 'update', 'delete', 'replace']);
const SCHEMA_KEYS = new Set(['db', 'schema']);

function identifierText(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value : propertyOf(value, 'value');
  return typeof text === 'string' ? text.replaceAll('``', '`') : undefined;
}

function collectAstSchemas(node: unknown, into: string[]): boolean {
  if (Array.isArray(node)) {
    return node.every((child) => collectAstSchemas(child, into));
  }
  if (typeof node !== 'object' || node === null) {
    return true;
  }
  return Object.entries(node).every(([key, value]) => {
    if (!SCHEMA_KEYS.has(key) || value === null || value === undefined) {
      return collectAstSchemas(value, into);
    }
    const schema = identifierText(value);
    if (schema !== undefined) {
      into.push(schema);
    }
    return schema !== undefined;
  });
}

function statementSchemas(code: string): string[] | undefined {
  const statements = parseExecutedStatements(code);
  if (statements === undefined || !statements.every((statement) => PARSED_AST_TYPES.has(propertyOf(statement, 'type')))) {
    return undefined;
  }
  const schemas: string[] = [];
  return collectAstSchemas(statements, schemas) ? schemas : undefined;
}

function skipShowModifiers(cursor: TokenCursor): void {
  cursor.take('full', 'extended');
  cursor.take('full');
}

function matchesShowListing(cursor: TokenCursor): boolean {
  skipShowModifiers(cursor);
  const listsTables = cursor.take('tables') || (cursor.take('table') && cursor.take('status'));
  const describesTable = !listsTables && cursor.take('columns', 'fields', 'index', 'indexes', 'keys');
  const namesKnownObject = listsTables || (describesTable && cursor.take('from', 'in') && cursor.takeTableName());
  if (!namesKnownObject) {
    return false;
  }
  if (cursor.take('from', 'in') && !cursor.takeSchemaName()) {
    return false;
  }
  return !(cursor.take('like') && !cursor.takeString());
}

function matchesShowCreate(cursor: TokenCursor): boolean {
  return cursor.take('table', 'view') && cursor.takeTableName();
}

function showSchemas(cursor: TokenCursor): string[] | undefined {
  if (cursor.take('databases', 'schemas')) {
    return ['information_schema'];
  }
  const matches = cursor.take('create') ? matchesShowCreate(cursor) : matchesShowListing(cursor);
  return matches && cursor.done() ? cursor.schemas : undefined;
}

function takeExplainOption(cursor: TokenCursor): boolean {
  return cursor.take('analyze', 'extended', 'partitions')
    || (cursor.take('format') && cursor.take('=') && (cursor.takeString() || cursor.takeName() !== undefined));
}

function skipExplainOptions(cursor: TokenCursor): void {
  let tookOption = takeExplainOption(cursor);
  while (tookOption) {
    tookOption = takeExplainOption(cursor);
  }
}

function explainSchemas(code: string, cursor: TokenCursor): string[] | undefined {
  skipExplainOptions(cursor);
  const next = cursor.peek();
  if (next && LEADING_KEYWORDS_TO_PARSE.has(next.text.toLowerCase())) {
    return statementSchemas(code.slice(next.at));
  }
  if (!cursor.takeTableName()) {
    return undefined;
  }
  if (!cursor.takeString()) {
    cursor.takeName();
  }
  return cursor.done() ? cursor.schemas : undefined;
}

export function reachedSchemas(code: string): string[] | undefined {
  const tokens = tokenize(code);
  const cursor = new TokenCursor(tokens.slice(1));
  const firstKeyword = tokens[0]?.text.toLowerCase() ?? '';
  if (firstKeyword === 'show') {
    return showSchemas(cursor);
  }
  if (EXPLAIN_KEYWORDS.has(firstKeyword)) {
    return explainSchemas(code, cursor);
  }
  return LEADING_KEYWORDS_TO_PARSE.has(firstKeyword) ? statementSchemas(code) : undefined;
}
