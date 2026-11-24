import { SQL_DATASOURCE_KINDS } from '../types/datasource.js';
import type { DatasourceProfile } from '../types/datasource.js';
import { databaseConfined, misconfiguredDatasource } from './taproot-error.js';
import { reachedSchemas } from './reached-schemas.js';
import { maskComments, maskCommentsAndLiterals } from './sql-parser.js';

type ConfinementInput = { sql: string; datasource: DatasourceProfile };

const EXECUTABLE_COMMENT_PATTERN = /\/\*[A-Za-z]?!/u;
const SEQUENCE_FUNCTION_PATTERN = /\b(?:nextval|setval|lastval)\b|\bnext\s+value\s+for\b/iu;
const UNSUPPORTED_STATEMENT_REASON =
  'it is not one SELECT, INSERT, UPDATE, DELETE, REPLACE, EXPLAIN or DESCRIBE TapRoot can parse, nor a SHOW TABLES, TABLE STATUS, COLUMNS, INDEX or CREATE TABLE/VIEW without WHERE';

function unsafeLexicalReason(sql: string): string | undefined {
  if (EXECUTABLE_COMMENT_PATTERN.test(sql)) {
    return 'it holds an executable comment (/*! */), which the server runs and the parser skips';
  }
  const code = maskCommentsAndLiterals(sql);
  if (code.includes('--')) {
    return "it holds '--' without an ASCII space after it, which the server reads as two minus signs and the parser may read as a comment";
  }
  if (SEQUENCE_FUNCTION_PATTERN.test(code)) {
    return 'it calls a sequence function, whose sequence the parser reads as a column';
  }
  if (sql.includes('\\')) {
    return 'it holds a backslash, which ends a string early on a server running NO_BACKSLASH_ESCAPES';
  }
  return undefined;
}

function isConfined(datasource: DatasourceProfile): boolean {
  return process.env.TAPROOT_CONFINE_TO_DATABASE === '1' && SQL_DATASOURCE_KINDS.has(datasource.kind);
}

function confinedDatabase(datasource: DatasourceProfile): string {
  const { database } = datasource.connection;
  if (database !== undefined && database !== '') {
    return database;
  }
  throw misconfiguredDatasource(`TAPROOT_CONFINE_TO_DATABASE confines datasource '${datasource.name}' to its database, but it names none. Set one with datasource add --database <schema>.`);
}

function otherSchemaError(datasource: DatasourceProfile, database: string, reached: string): Error {
  return databaseConfined(
    `datasource '${datasource.name}' is confined to schema '${database}', and '${reached}' is another schema. Name tables of '${database}' bare or as ${database}.<table>.`,
    { reached },
  );
}

function cannotConfirmSchemasError(datasource: DatasourceProfile, database: string, reason: string): Error {
  return databaseConfined(`datasource '${datasource.name}' is confined to schema '${database}', and TapRoot cannot tell which schemas this statement reaches: ${reason}.`);
}

function confirmedReachedSchemas(input: ConfinementInput, database: string): string[] {
  const hazard = unsafeLexicalReason(input.sql);
  if (hazard !== undefined) {
    throw cannotConfirmSchemasError(input.datasource, database, hazard);
  }
  const schemas = reachedSchemas(maskComments(input.sql));
  if (!schemas) {
    throw cannotConfirmSchemasError(input.datasource, database, UNSUPPORTED_STATEMENT_REASON);
  }
  return schemas;
}

export function enforceDatabaseConfinement(input: ConfinementInput): void {
  if (!isConfined(input.datasource)) {
    return;
  }
  const database = confinedDatabase(input.datasource);
  const outside = confirmedReachedSchemas(input, database).find((schema) => schema !== database);
  if (outside !== undefined) {
    throw otherSchemaError(input.datasource, database, outside);
  }
}
