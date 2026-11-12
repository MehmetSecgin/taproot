import type { SchemaContext, TableContext } from '../types/core.js';
import type { SchemaCatalog } from '../store/schema-catalog.js';
import { suggestNames } from './grpc-introspect.js';
import { explainAnalyzeTarget, parseExecutedStatements } from './sql-parser.js';
import { str } from './strings.js';

export interface PredicateColumnRefs {
  byTable: Map<string, Set<string>>;
  bare: Set<string>;
}

function normalizeName(value: string): string {
  return str(value).replace(/`/g, '').trim();
}

function bareName(value: string): string {
  return normalizeName(value).split('.').pop() || '';
}

function columnName(node: unknown): string {
  if (typeof node === 'string') return normalizeName(node);
  if (!node || typeof node !== 'object') return '';
  const expr = (node as Record<string, unknown>).expr;
  if (!expr || typeof expr !== 'object') return '';
  const value = (expr as Record<string, unknown>).value;
  return typeof value === 'string' ? normalizeName(value) : '';
}

function safeTableName(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const obj = node as Record<string, unknown>;
  const db = typeof obj.db === 'string' ? normalizeName(obj.db) : '';
  const table = typeof obj.table === 'string' ? normalizeName(obj.table) : '';
  if (!table) return '';
  return db ? `${db}.${table}` : table;
}

function safeAlias(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const value = (node as Record<string, unknown>).as;
  return typeof value === 'string' ? normalizeName(value) : '';
}

function eachChild(obj: Record<string, unknown>, visit: (child: unknown) => void): void {
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) value.forEach(visit);
    else visit(value);
  }
}

function collectCteNames(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const withItems = Array.isArray(obj.with) ? obj.with : [];
  for (const item of withItems) {
    if (!item || typeof item !== 'object') continue;
    const nameNode = (item as Record<string, unknown>).name;
    const value = nameNode && typeof nameNode === 'object' ? (nameNode as Record<string, unknown>).value : undefined;
    if (typeof value === 'string') out.add(bareName(value));
  }
  eachChild(obj, (child) => collectCteNames(child, out));
}

function collectTablesFromNode(node: unknown, cteNames: Set<string>, tables: Set<string>, aliasToTable: Map<string, string>): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  const from = Array.isArray(obj.from) ? obj.from : [];
  for (const item of from) {
    const tableName = safeTableName(item);
    const tableBare = bareName(tableName);
    if (tableName && !cteNames.has(tableBare)) {
      tables.add(tableBare);
      const alias = safeAlias(item);
      if (alias) aliasToTable.set(alias, tableBare);
      aliasToTable.set(tableBare, tableBare);
    }
  }

  const showTable = safeTableName(obj.table);
  if (showTable && !cteNames.has(bareName(showTable))) tables.add(bareName(showTable));

  eachChild(obj, (child) => collectTablesFromNode(child, cteNames, tables, aliasToTable));
}

function scanTables(statements: unknown[]): { tables: Set<string>; aliasToTable: Map<string, string> } {
  const cteNames = new Set<string>();
  const tables = new Set<string>();
  const aliasToTable = new Map<string, string>();
  for (const item of statements) collectCteNames(item, cteNames);
  for (const item of statements) collectTablesFromNode(item, cteNames, tables, aliasToTable);
  return { tables, aliasToTable };
}

export function collectReferencedTables(sql: string): string[] {
  const statements = parseExecutedStatements(sql);
  if (!statements) return [];
  return [...scanTables(statements).tables].sort((a, b) => a.localeCompare(b));
}

function collectColumnRefs(expr: unknown, aliasToTable: Map<string, string>, out: PredicateColumnRefs): void {
  if (!expr || typeof expr !== 'object') return;
  const obj = expr as Record<string, unknown>;
  if (obj.type === 'column_ref') {
    const column = columnName(obj.column);
    const tableRaw = typeof obj.table === 'string' ? normalizeName(obj.table) : '';
    if (!column) return;
    if (!tableRaw) {
      out.bare.add(column);
      return;
    }
    const table = aliasToTable.get(tableRaw) || bareName(tableRaw);
    const set = out.byTable.get(table) || new Set<string>();
    set.add(column);
    out.byTable.set(table, set);
    return;
  }

  eachChild(obj, (child) => collectColumnRefs(child, aliasToTable, out));
}

function collectPredicateColumnsFromNode(node: unknown, aliasToTable: Map<string, string>, out: PredicateColumnRefs): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (obj.where) collectColumnRefs(obj.where, aliasToTable, out);
  if (obj.on) collectColumnRefs(obj.on, aliasToTable, out);

  eachChild(obj, (child) => collectPredicateColumnsFromNode(child, aliasToTable, out));
}

export function collectPredicateColumns(sql: string): PredicateColumnRefs {
  const out: PredicateColumnRefs = { byTable: new Map(), bare: new Set() };
  const statements = parseExecutedStatements(sql);
  if (!statements) return out;
  const { aliasToTable } = scanTables(statements);
  for (const item of statements) collectPredicateColumnsFromNode(item, aliasToTable, out);
  return out;
}

export function isSchemaMetadataQuery(sql: string): boolean {
  if (explainAnalyzeTarget(sql) !== undefined) return false;
  const text = str(sql).trim().replace(/\s+/g, ' ').toLowerCase();
  return /^(show\s+(create\s+(table|view)\b|tables\b|(full\s+)?(columns|fields)\b|(index(es)?|keys)\b)|describe\b|desc\b|explain\b)/.test(text);
}

export function buildSchemaContext(sql: string, catalog: SchemaCatalog | undefined): SchemaContext {
  if (!catalog) return { tables: {} };
  const byName = new Map(Object.keys(catalog.tables).map((table) => [table.toLowerCase(), table]));
  const tables: Record<string, TableContext> = {};
  for (const referenced of collectReferencedTables(sql)) {
    const table = byName.get(referenced.toLowerCase());
    if (table) tables[table] = catalog.tables[table];
  }
  return { tables, catalog: { tables: byName.size, fetchedAt: catalog.fetchedAt } };
}

const MISSING_COLUMN_RES = [/unknown column '([^']+)'/i];
const MISSING_TABLE_RES = [/table '([^']+)' doesn't exist/i, /unknown table '([^']+)'/i];

function missingName(message: string, patterns: RegExp[]): string {
  return patterns.map((re) => message.match(re)?.[1]).find(Boolean) || '';
}

export function suggestSchemaNames(code: string, message: string, schemaContext: SchemaContext, catalog: SchemaCatalog | undefined): string[] {
  if (code === 'UNKNOWN_COLUMN') {
    const missing = missingName(message, MISSING_COLUMN_RES);
    const columns = Object.entries(schemaContext.tables).flatMap(([table, ctx]) => ctx.columns.map((column) => `${table}.${column}`));
    return missing ? suggestNames(missing, columns, 3) : [];
  }
  if (code === 'UNKNOWN_TABLE') {
    const missing = bareName(missingName(message, MISSING_TABLE_RES));
    const tables = Object.keys(catalog?.tables || {});
    return missing ? suggestNames(missing, tables, 3) : [];
  }
  return [];
}
