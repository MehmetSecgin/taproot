import { SQL_DATASOURCE_KINDS } from '../types/core.js';
import type { DatasourceProfile } from '../types/core.js';
import { databaseConfined, misconfiguredDatasource } from './error-classification.js';
import { maskComments, maskCommentsAndLiterals, parseExecutedStatements } from './sql-parser.js';

interface Token {
  text: string;
  at: number;
}

const TOKEN_RE = /\s*(`(?:[^`]|``)*`|'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|[\w$\u0080-￿]+|\S)/gy;
const NAME_RE = /^(?:`|[\w$\u0080-￿])/;
const STRING_RE = /^['"]/;
const EXECUTABLE_COMMENT_RE = /\/\*[A-Za-z]?!/;
const SEQUENCE_FUNCTION_RE = /\b(?:nextval|setval|lastval)\b|\bnext\s+value\s+for\b/i;
const STATEMENT_STARTS = new Set(['select', 'with', 'insert', 'update', 'delete', 'replace', '(']);
const PARSED_STATEMENT_TYPES = new Set(['select', 'insert', 'update', 'delete', 'replace']);
const SCHEMA_KEYS = new Set(['db', 'schema']);
const UNSUPPORTED =
  'it is not one SELECT, INSERT, UPDATE, DELETE, REPLACE, EXPLAIN or DESCRIBE TapRoot can parse, nor a SHOW TABLES, TABLE STATUS, COLUMNS, INDEX or CREATE TABLE/VIEW without WHERE';

class TokenCursor {
  private at = 0;
  readonly schemas: string[] = [];

  constructor(private readonly tokens: Token[]) {}

  peek(): Token | undefined {
    return this.tokens[this.at];
  }

  take(...words: string[]): boolean {
    const next = this.peek()?.text.toLowerCase();
    if (next === undefined || !words.includes(next)) return false;
    this.at += 1;
    return true;
  }

  takeString(): boolean {
    if (!STRING_RE.test(this.peek()?.text ?? '')) return false;
    this.at += 1;
    return true;
  }

  takeName(): string | undefined {
    const text = this.peek()?.text ?? '';
    if (!NAME_RE.test(text)) return undefined;
    this.at += 1;
    return text.startsWith('`') ? text.slice(1, -1).replaceAll('``', '`') : text;
  }

  takeSchemaName(): boolean {
    const schema = this.takeName();
    if (schema !== undefined) this.schemas.push(schema);
    return schema !== undefined;
  }

  takeTableName(): boolean {
    const first = this.takeName();
    if (first === undefined) return false;
    if (!this.take('.')) return true;
    this.schemas.push(first);
    return this.takeName() !== undefined;
  }

  done(): boolean {
    return this.at === this.tokens.length;
  }
}

function tokenize(code: string): Token[] {
  const tokens = [...code.matchAll(TOKEN_RE)].map((match) => ({ text: match[1], at: match.index + match[0].length - match[1].length }));
  return tokens.at(-1)?.text === ';' ? tokens.slice(0, -1) : tokens;
}

function identifierText(value: unknown): string | undefined {
  const text = typeof value === 'string' ? value : (value as { value?: unknown } | null)?.value;
  return typeof text === 'string' ? text.replaceAll('``', '`') : undefined;
}

function collectAstSchemas(node: unknown, into: string[]): boolean {
  if (Array.isArray(node)) return node.every((child) => collectAstSchemas(child, into));
  if (!node || typeof node !== 'object') return true;
  return Object.entries(node).every(([key, value]) => {
    if (!SCHEMA_KEYS.has(key) || value == null) return collectAstSchemas(value, into);
    const schema = identifierText(value);
    if (schema !== undefined) into.push(schema);
    return schema !== undefined;
  });
}

function statementSchemas(code: string): string[] | undefined {
  const statements = parseExecutedStatements(code);
  if (!statements?.every((statement) => PARSED_STATEMENT_TYPES.has((statement as { type?: string }).type ?? ''))) return undefined;
  const schemas: string[] = [];
  return collectAstSchemas(statements, schemas) ? schemas : undefined;
}

function showSchemas(cursor: TokenCursor): string[] | undefined {
  if (cursor.take('databases', 'schemas')) return ['information_schema'];
  if (cursor.take('create')) {
    if (!cursor.take('table', 'view') || !cursor.takeTableName()) return undefined;
  } else {
    cursor.take('full', 'extended');
    cursor.take('full');
    const listsTables = cursor.take('tables') || (cursor.take('table') && cursor.take('status'));
    const describesTable = !listsTables && cursor.take('columns', 'fields', 'index', 'indexes', 'keys');
    if (!listsTables && !(describesTable && cursor.take('from', 'in') && cursor.takeTableName())) return undefined;
    if (cursor.take('from', 'in') && !cursor.takeSchemaName()) return undefined;
    if (cursor.take('like') && !cursor.takeString()) return undefined;
  }
  return cursor.done() ? cursor.schemas : undefined;
}

function explainSchemas(code: string, cursor: TokenCursor): string[] | undefined {
  let tookOption = true;
  while (tookOption) {
    tookOption = cursor.take('analyze', 'extended', 'partitions') || (cursor.take('format') && cursor.take('=') && (cursor.takeString() || cursor.takeName() !== undefined));
  }
  const next = cursor.peek();
  if (next && STATEMENT_STARTS.has(next.text.toLowerCase())) return statementSchemas(code.slice(next.at));
  if (!cursor.takeTableName()) return undefined;
  if (!cursor.takeString()) cursor.takeName();
  return cursor.done() ? cursor.schemas : undefined;
}

function reachedSchemas(code: string): string[] | undefined {
  const tokens = tokenize(code);
  const cursor = new TokenCursor(tokens.slice(1));
  const first = tokens[0]?.text.toLowerCase() ?? '';
  if (first === 'show') return showSchemas(cursor);
  if (['explain', 'describe', 'desc'].includes(first)) return explainSchemas(code, cursor);
  return STATEMENT_STARTS.has(first) ? statementSchemas(code) : undefined;
}

function lexicalHazard(sql: string): string | undefined {
  if (EXECUTABLE_COMMENT_RE.test(sql)) return 'it holds an executable comment (/*! */), which the server runs and the parser skips';
  const code = maskCommentsAndLiterals(sql);
  if (code.includes('--')) return "it holds '--' without an ASCII space after it, which the server reads as two minus signs and the parser may read as a comment";
  if (SEQUENCE_FUNCTION_RE.test(code)) return 'it calls a sequence function, whose sequence the parser reads as a column';
  if (sql.includes('\\')) return 'it holds a backslash, which ends a string early on a server running NO_BACKSLASH_ESCAPES';
  return undefined;
}

function isConfined(datasource: DatasourceProfile): boolean {
  return process.env.TAPROOT_CONFINE_TO_DATABASE === '1' && SQL_DATASOURCE_KINDS.has(datasource.kind);
}

function confinedDatabase(datasource: DatasourceProfile): string {
  const database = datasource.connection.database;
  if (database) return database;
  throw misconfiguredDatasource(`TAPROOT_CONFINE_TO_DATABASE confines datasource '${datasource.name}' to its database, but it names none. Set one with datasource add --database <schema>.`);
}

function outsideDatabase(datasource: DatasourceProfile, database: string, reached: string): Error {
  return databaseConfined(
    `datasource '${datasource.name}' is confined to schema '${database}', and '${reached}' is another schema. Name tables of '${database}' bare or as ${database}.<table>.`,
    { reached },
  );
}

function unconfirmedReach(datasource: DatasourceProfile, database: string, reason: string): Error {
  return databaseConfined(`datasource '${datasource.name}' is confined to schema '${database}', and TapRoot cannot tell which schemas this statement reaches: ${reason}.`);
}

export function enforceDatabaseConfinement(input: { sql: string; datasource: DatasourceProfile }): void {
  if (!isConfined(input.datasource)) return;
  const database = confinedDatabase(input.datasource);
  const hazard = lexicalHazard(input.sql);
  if (hazard) throw unconfirmedReach(input.datasource, database, hazard);
  const schemas = reachedSchemas(maskComments(input.sql));
  if (!schemas) throw unconfirmedReach(input.datasource, database, UNSUPPORTED);
  const outside = schemas.find((schema) => schema !== database);
  if (outside !== undefined) throw outsideDatabase(input.datasource, database, outside);
}
