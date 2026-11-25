import type { SchemaContext, TableContext } from '../types/schema-context.js';
import type { SchemaCatalog } from '../store/schema-catalog.js';
import { suggestNames } from './name-match.js';
import { bareTableName, collectReferencedTables } from './sql-ast-references.js';

const MAX_NAME_SUGGESTIONS = 3;
const MISSING_COLUMN_PATTERN = /unknown column '(?<name>[^']+)'/iu;
const MISSING_TABLE_PATTERNS = [/table '(?<name>[^']+)' doesn't exist/iu, /unknown table '(?<name>[^']+)'/iu];

export function buildSchemaContext(sql: string, catalog: SchemaCatalog | undefined): SchemaContext {
  if (catalog === undefined) {
    return { tables: {} };
  }
  const catalogTableByLowercaseName = new Map(Object.keys(catalog.tables).map((table) => [table.toLowerCase(), table]));
  const tables: Record<string, TableContext> = {};
  for (const referenced of collectReferencedTables(sql)) {
    const table = catalogTableByLowercaseName.get(referenced);
    if (table !== undefined) {
      tables[table] = catalog.tables[table];
    }
  }
  return { tables, catalog: { tables: catalogTableByLowercaseName.size, fetchedAt: catalog.fetchedAt } };
}

function missingName(message: string, patterns: RegExp[]): string {
  const names = patterns.map((pattern) => pattern.exec(message)?.groups?.name);
  return names.find((name) => name !== undefined && name !== '') ?? '';
}

export function suggestSchemaNames(failure: { code: string; message: string }, schemaContext: SchemaContext, catalog: SchemaCatalog | undefined): string[] {
  const { code, message } = failure;
  if (code === 'UNKNOWN_COLUMN') {
    const missingColumn = missingName(message, [MISSING_COLUMN_PATTERN]);
    const qualifiedColumns = Object.entries(schemaContext.tables).flatMap(([table, tableContext]) =>
      tableContext.columns.map((column) => `${table}.${column}`),
    );
    return missingColumn === '' ? [] : suggestNames(missingColumn, qualifiedColumns, MAX_NAME_SUGGESTIONS);
  }
  if (code === 'UNKNOWN_TABLE') {
    const missingTable = bareTableName(missingName(message, MISSING_TABLE_PATTERNS));
    const catalogTables = Object.keys(catalog?.tables ?? {});
    return missingTable === '' ? [] : suggestNames(missingTable, catalogTables, MAX_NAME_SUGGESTIONS);
  }
  return [];
}
