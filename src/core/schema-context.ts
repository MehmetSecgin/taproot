import parserPkg from 'node-sql-parser';
import type { SchemaContext, TableContext } from '../types/core.js';
import { schemaObservationHasCurrentMetadata, type LearningStore, type SchemaObservationEntry } from '../store/learning.js';
import { str } from './strings.js';

const { Parser } = parserPkg as unknown as {
  Parser: new () => { astify: (sql: string, opts?: Record<string, unknown>) => unknown };
};

const parser = new Parser();

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

function parseAst(sql: string): unknown | null {
  try {
    return parser.astify(sql, { database: 'mysql' });
  } catch {
    return null;
  }
}

function eachAst(ast: unknown): unknown[] {
  return Array.isArray(ast) ? ast : [ast];
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
  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) collectCteNames(item, out);
    } else {
      collectCteNames(value, out);
    }
  }
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

  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) collectTablesFromNode(item, cteNames, tables, aliasToTable);
    } else {
      collectTablesFromNode(value, cteNames, tables, aliasToTable);
    }
  }
}

export function collectReferencedTables(sql: string): string[] {
  const ast = parseAst(sql);
  if (!ast) return [];
  const cteNames = new Set<string>();
  const tables = new Set<string>();
  const aliasToTable = new Map<string, string>();
  for (const item of eachAst(ast)) collectCteNames(item, cteNames);
  for (const item of eachAst(ast)) collectTablesFromNode(item, cteNames, tables, aliasToTable);
  return [...tables].sort((a, b) => a.localeCompare(b));
}

function collectColumnRefs(expr: unknown, aliasToTable: Map<string, string>, out: PredicateColumnRefs): void {
  if (!expr || typeof expr !== 'object') return;
  const obj = expr as Record<string, unknown>;
  if (obj.type === 'column_ref') {
    const column = typeof obj.column === 'string' ? normalizeName(obj.column) : '';
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

  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) collectColumnRefs(item, aliasToTable, out);
    } else {
      collectColumnRefs(value, aliasToTable, out);
    }
  }
}

function collectPredicateColumnsFromNode(node: unknown, aliasToTable: Map<string, string>, out: PredicateColumnRefs): void {
  if (!node || typeof node !== 'object') return;
  const obj = node as Record<string, unknown>;
  if (obj.where) collectColumnRefs(obj.where, aliasToTable, out);
  if (obj.on) collectColumnRefs(obj.on, aliasToTable, out);

  for (const value of Object.values(obj)) {
    if (Array.isArray(value)) {
      for (const item of value) collectPredicateColumnsFromNode(item, aliasToTable, out);
    } else {
      collectPredicateColumnsFromNode(value, aliasToTable, out);
    }
  }
}

export function collectPredicateColumns(sql: string): PredicateColumnRefs {
  const out: PredicateColumnRefs = { byTable: new Map(), bare: new Set() };
  const ast = parseAst(sql);
  if (!ast) return out;
  const cteNames = new Set<string>();
  const aliasToTable = new Map<string, string>();
  const tables = new Set<string>();
  for (const item of eachAst(ast)) collectCteNames(item, cteNames);
  for (const item of eachAst(ast)) collectTablesFromNode(item, cteNames, tables, aliasToTable);
  for (const item of eachAst(ast)) collectPredicateColumnsFromNode(item, aliasToTable, out);
  return out;
}

export function isSchemaMetadataQuery(sql: string): boolean {
  const text = str(sql).trim().replace(/\s+/g, ' ').toLowerCase();
  return /^(show\s+(create\s+table|tables\b|full\s+columns\b|index\b)|describe\b|desc\b|explain\b)/.test(text);
}

function matchesTable(row: SchemaObservationEntry, table: string): boolean {
  return bareName(row.table).toLowerCase() === bareName(table).toLowerCase();
}

export function buildSchemaContext(sql: string, target: string | { service?: string }, store: LearningStore): SchemaContext {
  const referenced = collectReferencedTables(sql);
  if (!referenced.length) return { tables: {} };
  const service = typeof target === 'string' ? target : str(target?.service);
  const rows = store.schemaTables(service || undefined);
  const out: Record<string, TableContext> = {};
  for (const table of referenced) {
    const row = rows
      .filter((item) => matchesTable(item, table))
      .sort((a, b) => {
        const completeDelta = Number(schemaObservationHasCurrentMetadata(b)) - Number(schemaObservationHasCurrentMetadata(a));
        if (completeDelta) return completeDelta;
        return b.columns.length - a.columns.length || String(b.lastSeenAt).localeCompare(String(a.lastSeenAt));
      })[0];
    if (!row) continue;
    const trimmedIndexes = (row.indexes || []).map((index) => {
      const o: { name: string; columns: string[]; unique?: boolean; type?: string } = {
        name: index.name,
        columns: index.columns || [],
      };
      if (index.unique) o.unique = true;
      if (index.type && String(index.type).toUpperCase() !== 'BTREE') o.type = index.type;
      return o;
    });
    out[row.table] = {
      database: row.database,
      columns: row.columns.map((column) => column.column),
      primaryKey: row.primaryKey || [],
      indexes: trimmedIndexes,
      partition: row.partition,
    };
  }
  return { tables: out };
}
