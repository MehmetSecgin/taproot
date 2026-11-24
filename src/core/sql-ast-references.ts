import { parseExecutedStatements } from './sql-parser.js';
import { textUnlessFalsy } from './text-presence.js';

export type PredicateColumnRefs = {
  byTable: Map<string, Set<string>>;
  bare: Set<string>;
};

type AstNode = Record<string, unknown>;

type TableScan = {
  cteNames: Set<string>;
  tables: Set<string>;
  aliasToTable: Map<string, string>;
};

function isAstNode(node: unknown): node is AstNode {
  return typeof node === 'object' && node !== null;
}

function unquotedLowercase(value: string): string {
  return textUnlessFalsy(value).replaceAll('`', '').trim().toLowerCase();
}

export function bareTableName(value: string): string {
  return unquotedLowercase(value).split('.').at(-1) ?? '';
}

function normalizedTextField(node: AstNode, field: string): string {
  const value = node[field];
  return typeof value === 'string' ? unquotedLowercase(value) : '';
}

function columnName(node: unknown): string {
  if (typeof node === 'string') {
    return unquotedLowercase(node);
  }
  const value = isAstNode(node) && isAstNode(node.expr) ? node.expr.value : undefined;
  return typeof value === 'string' ? unquotedLowercase(value) : '';
}

function astTableName(node: unknown): string {
  if (!isAstNode(node)) {
    return '';
  }
  const database = normalizedTextField(node, 'db');
  const table = normalizedTextField(node, 'table');
  if (table === '') {
    return '';
  }
  return database === '' ? table : `${database}.${table}`;
}

function astAlias(node: unknown): string {
  return isAstNode(node) ? normalizedTextField(node, 'as') : '';
}

function visitChildren(node: AstNode, visit: (child: unknown) => void): void {
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value as unknown[]) {
        visit(child);
      }
    } else {
      visit(value);
    }
  }
}

function collectCteNames(node: unknown, cteNames: Set<string>): void {
  if (!isAstNode(node)) {
    return;
  }
  const withItems: unknown[] = Array.isArray(node.with) ? node.with : [];
  for (const item of withItems) {
    const nameNode = isAstNode(item) ? item.name : undefined;
    const cteName = isAstNode(nameNode) ? nameNode.value : undefined;
    if (typeof cteName === 'string') {
      cteNames.add(bareTableName(cteName));
    }
  }
  visitChildren(node, (child) => {
    collectCteNames(child, cteNames);
  });
}

function addFromItem(scan: TableScan, item: unknown): void {
  const tableName = astTableName(item);
  const bareName = bareTableName(tableName);
  if (tableName === '' || scan.cteNames.has(bareName)) {
    return;
  }
  scan.tables.add(bareName);
  const alias = astAlias(item);
  if (alias !== '') {
    scan.aliasToTable.set(alias, bareName);
  }
  scan.aliasToTable.set(bareName, bareName);
}

function addShowTable(scan: TableScan, node: AstNode): void {
  const showTable = astTableName(node.table);
  if (showTable !== '' && !scan.cteNames.has(bareTableName(showTable))) {
    scan.tables.add(bareTableName(showTable));
  }
}

function collectTablesFromNode(node: unknown, scan: TableScan): void {
  if (!isAstNode(node)) {
    return;
  }
  const fromItems: unknown[] = Array.isArray(node.from) ? node.from : [];
  for (const item of fromItems) {
    addFromItem(scan, item);
  }
  addShowTable(scan, node);
  visitChildren(node, (child) => {
    collectTablesFromNode(child, scan);
  });
}

function scanTables(statements: readonly unknown[]): TableScan {
  const scan: TableScan = { cteNames: new Set(), tables: new Set(), aliasToTable: new Map() };
  for (const statement of statements) {
    collectCteNames(statement, scan.cteNames);
  }
  for (const statement of statements) {
    collectTablesFromNode(statement, scan);
  }
  return scan;
}

export function collectReferencedTables(sql: string): string[] {
  const statements = parseExecutedStatements(sql);
  if (statements === undefined) {
    return [];
  }
  return [...scanTables(statements).tables].toSorted((left, right) => left.localeCompare(right));
}

function addTableColumn(refs: PredicateColumnRefs, table: string, column: string): void {
  const columns = refs.byTable.get(table) ?? new Set<string>();
  columns.add(column);
  refs.byTable.set(table, columns);
}

function addColumnRef(node: AstNode, aliasToTable: Map<string, string>, refs: PredicateColumnRefs): void {
  const column = columnName(node.column);
  const tableName = typeof node.table === 'string' ? unquotedLowercase(node.table) : '';
  if (column === '') {
    return;
  }
  if (tableName === '') {
    refs.bare.add(column);
    return;
  }
  addTableColumn(refs, aliasToTable.get(tableName) ?? bareTableName(tableName), column);
}

function collectColumnRefs(expression: unknown, aliasToTable: Map<string, string>, refs: PredicateColumnRefs): void {
  if (!isAstNode(expression)) {
    return;
  }
  if (expression.type === 'column_ref') {
    addColumnRef(expression, aliasToTable, refs);
    return;
  }
  visitChildren(expression, (child) => {
    collectColumnRefs(child, aliasToTable, refs);
  });
}

function collectPredicateColumnsFromNode(node: unknown, aliasToTable: Map<string, string>, refs: PredicateColumnRefs): void {
  if (!isAstNode(node)) {
    return;
  }
  collectColumnRefs(node.where, aliasToTable, refs);
  collectColumnRefs(node.on, aliasToTable, refs);
  visitChildren(node, (child) => {
    collectPredicateColumnsFromNode(child, aliasToTable, refs);
  });
}

export function collectPredicateColumns(sql: string): PredicateColumnRefs {
  const refs: PredicateColumnRefs = { byTable: new Map(), bare: new Set() };
  const statements = parseExecutedStatements(sql);
  if (statements === undefined) {
    return refs;
  }
  const { aliasToTable } = scanTables(statements);
  for (const statement of statements) {
    collectPredicateColumnsFromNode(statement, aliasToTable, refs);
  }
  return refs;
}
