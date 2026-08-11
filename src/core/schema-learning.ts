import parserPkg from 'node-sql-parser';
import { dialectFromKind, parserDatabaseOption, type SqlDialect } from './sql-dialect.js';

export type ColumnRole = 'select' | 'filter' | 'group' | 'order';

export interface TableObservation {
  table: string;
  alias?: string;
}

export interface JoinObservation {
  leftTable: string;
  rightTable: string;
  conditionRaw: string;
  conditionNormalized: string;
  directionHint: 'left-to-right' | 'right-to-left' | 'unknown';
}

export interface ColumnObservation {
  table?: string;
  column: string;
  role: ColumnRole;
}

export interface QueryShapeObservation {
  operation: string;
  normalizedSql: string;
  tables: TableObservation[];
  joins: JoinObservation[];
  columns: ColumnObservation[];
  confidence: number;
}

const { Parser } = parserPkg as unknown as {
  Parser: new () => { astify: (sql: string, opt?: { database?: string }) => unknown };
};
const parser = new Parser();

function normalizeText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeSqlShape(sql: string): string {
  let out = sql.trim().replace(/\s+/g, ' ').toLowerCase();
  out = out.replace(/'(?:''|[^'])*'/g, ':str');
  out = out.replace(/"(?:\\"|[^"])*"/g, ':str');
  out = out.replace(/\b\d+\.\d+\b/g, ':num');
  out = out.replace(/\b\d+\b/g, ':num');
  out = out.replace(/\b(true|false)\b/g, ':bool');
  return out.replace(/\s+/g, ' ').trim();
}

function operationFromSql(sql: string): string {
  const op = sql.trim().split(/\s+/, 1)[0] || '';
  return op.toLowerCase();
}

function safeTableName(node: unknown): string {
  if (!node || typeof node !== 'object') return '';
  const obj = node as Record<string, unknown>;
  const db = typeof obj.db === 'string' ? obj.db : '';
  const table = typeof obj.table === 'string' ? obj.table : '';
  if (!table) return '';
  return db ? `${db}.${table}` : table;
}

function safeAlias(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const value = (node as Record<string, unknown>).as;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function extractColumnName(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!value || typeof value !== 'object') return '';
  const node = value as Record<string, unknown>;
  if (typeof node.value === 'string') return node.value;
  if (node.expr) return extractColumnName(node.expr);
  return '';
}

function emitColumnRef(expr: unknown, role: ColumnRole, out: ColumnObservation[]): void {
  if (!expr || typeof expr !== 'object') return;
  const node = expr as Record<string, unknown>;
  if (node.type === 'column_ref') {
    const column = extractColumnName(node.column);
    if (!column) return;
    const table = typeof node.table === 'string' && node.table ? node.table : undefined;
    out.push({ table, column, role });
    return;
  }

  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const item of value) emitColumnRef(item, role, out);
      continue;
    }
    emitColumnRef(value, role, out);
  }
}

function expressionToString(expr: unknown): string {
  if (!expr || typeof expr !== 'object') return '';
  const node = expr as Record<string, unknown>;
  const type = typeof node.type === 'string' ? node.type : '';

  if (type === 'column_ref') {
    const table = typeof node.table === 'string' && node.table ? `${node.table}.` : '';
    const column = extractColumnName(node.column);
    return `${table}${column}`;
  }

  if (type === 'binary_expr') {
    const left = expressionToString(node.left);
    const right = expressionToString(node.right);
    const op = typeof node.operator === 'string' ? node.operator : '?';
    return `${left} ${op} ${right}`.trim();
  }

  if (type === 'unary_expr') {
    const op = typeof node.operator === 'string' ? node.operator : '';
    const value = expressionToString(node.expr);
    return `${op} ${value}`.trim();
  }

  if (type === 'number' || type === 'string' || type === 'single_quote_string' || type === 'bool') {
    return ':lit';
  }

  if (type === 'expr_list' && Array.isArray(node.value)) {
    return node.value.map((v) => expressionToString(v)).filter(Boolean).join(', ');
  }

  if (node.value !== undefined) {
    if (typeof node.value === 'string') return node.value;
    if (typeof node.value === 'number' || typeof node.value === 'boolean') return ':lit';
    return expressionToString(node.value);
  }

  return '';
}

function parseSelectLikeAst(ast: Record<string, unknown>): {
  tables: TableObservation[];
  joins: JoinObservation[];
  columns: ColumnObservation[];
} {
  const cteNames = new Set(
    (Array.isArray(ast.with) ? ast.with : [])
      .map((entry) => {
        if (!entry || typeof entry !== 'object') return '';
        const name = (entry as Record<string, unknown>).name;
        if (!name || typeof name !== 'object') return '';
        const value = (name as Record<string, unknown>).value;
        return typeof value === 'string' ? value.trim() : '';
      })
      .filter(Boolean),
  );
  const tables: TableObservation[] = [];
  const joins: JoinObservation[] = [];
  const columns: ColumnObservation[] = [];

  const aliasToTable = new Map<string, string>();
  const from = Array.isArray(ast.from) ? ast.from : [];
  let lastTable = '';
  for (const item of from) {
    const tableName = safeTableName(item);
    if (!tableName) continue;
    const bareTableName = tableName.split('.').pop() || tableName;
    if (cteNames.has(bareTableName)) continue;
    const alias = safeAlias(item);
    tables.push({ table: tableName, alias });
    if (alias) aliasToTable.set(alias, tableName);

    const itemObj = item as Record<string, unknown>;
    const joinToken = typeof itemObj.join === 'string' ? itemObj.join : '';
    if (lastTable && joinToken) {
      const raw = expressionToString(itemObj.on);
      const normalized = normalizeText(raw.replace(/'(?:''|[^'])*'/g, ':str').replace(/\b\d+\b/g, ':num'));
      joins.push({
        leftTable: lastTable,
        rightTable: tableName,
        conditionRaw: raw,
        conditionNormalized: normalized,
        directionHint: joinToken.toUpperCase().includes('RIGHT') ? 'right-to-left' : 'left-to-right',
      });
    }
    lastTable = tableName;
  }

  const cols = Array.isArray(ast.columns) ? ast.columns : [];
  for (const col of cols) {
    if (!col || typeof col !== 'object') continue;
    emitColumnRef((col as Record<string, unknown>).expr, 'select', columns);
  }

  emitColumnRef(ast.where, 'filter', columns);
  if (Array.isArray(ast.groupby)) {
    for (const g of ast.groupby) emitColumnRef(g, 'group', columns);
  } else if (ast.groupby && typeof ast.groupby === 'object') {
    const groupObj = ast.groupby as Record<string, unknown>;
    if (Array.isArray(groupObj.columns)) {
      for (const g of groupObj.columns) emitColumnRef(g, 'group', columns);
    } else {
      emitColumnRef(ast.groupby, 'group', columns);
    }
  }
  if (Array.isArray(ast.orderby)) {
    for (const o of ast.orderby) {
      if (o && typeof o === 'object') emitColumnRef((o as Record<string, unknown>).expr, 'order', columns);
    }
  }

  const resolvedColumns = columns.map((c) => {
    if (!c.table) return c;
    const table = aliasToTable.get(c.table) || c.table;
    return { ...c, table };
  });

  function collectNestedSelects(node: unknown, out: Record<string, unknown>[]): void {
    if (!node || typeof node !== 'object') return;
    const current = node as Record<string, unknown>;
    if (current !== ast && typeof current.type === 'string' && current.type.toLowerCase() === 'select') {
      out.push(current);
    }
    if (current.ast && typeof current.ast === 'object') {
      collectNestedSelects(current.ast, out);
    }
    for (const value of Object.values(current)) {
      if (Array.isArray(value)) {
        for (const item of value) collectNestedSelects(item, out);
      } else if (value && typeof value === 'object') {
        collectNestedSelects(value, out);
      }
    }
  }

  const nestedSelects: Record<string, unknown>[] = [];
  collectNestedSelects(ast, nestedSelects);
  for (const nested of nestedSelects) {
    const parsed = parseSelectLikeAst(nested);
    tables.push(...parsed.tables);
    joins.push(...parsed.joins);
    resolvedColumns.push(...parsed.columns);
  }

  const dedupedTables = Array.from(
    new Map(tables.map((row) => [`${row.table}|${row.alias || ''}`, row])),
  ).map(([, row]) => row);
  const dedupedJoins = Array.from(
    new Map(joins.map((row) => [`${row.leftTable}|${row.rightTable}|${row.conditionNormalized}`, row])),
  ).map(([, row]) => row);
  const dedupedColumns = Array.from(
    new Map(resolvedColumns.map((row) => [`${row.table || ''}|${row.column}|${row.role}`, row])),
  ).map(([, row]) => row);

  return { tables: dedupedTables, joins: dedupedJoins, columns: dedupedColumns };
}

function fallbackExtract(sql: string): QueryShapeObservation {
  const normalizedSql = normalizeSqlShape(sql);
  const operation = operationFromSql(sql);
  const tableMatches = Array.from(sql.matchAll(/\b(?:from|join|into|update|table)\s+([a-zA-Z0-9_.`]+)/gi));
  const tables = tableMatches
    .map((m) => m[1].replace(/`/g, '').trim())
    .filter(Boolean)
    .map((table) => ({ table }));

  return {
    operation,
    normalizedSql,
    tables,
    joins: [],
    columns: [],
    confidence: tables.length ? 0.55 : 0.35,
  };
}

export function extractQueryShape(sql: string, options?: { dialect?: SqlDialect | string }): QueryShapeObservation {
  const normalizedSql = normalizeSqlShape(sql);
  const operation = operationFromSql(sql);
  const dialect = dialectFromKind(options?.dialect);

  try {
    const astRaw = parser.astify(sql, { database: parserDatabaseOption(dialect) });
    const ast = Array.isArray(astRaw) ? astRaw[0] : astRaw;
    if (!ast || typeof ast !== 'object') return fallbackExtract(sql);

    const astObj = ast as unknown as Record<string, unknown>;
    const type = typeof astObj.type === 'string' ? astObj.type.toLowerCase() : operation;
    if (type === 'select') {
      const parsed = parseSelectLikeAst(astObj);
      return {
        operation: type,
        normalizedSql,
        tables: parsed.tables,
        joins: parsed.joins,
        columns: parsed.columns,
        confidence: 0.92,
      };
    }

    if (type === 'show' || type === 'describe' || type === 'explain') {
      const table = safeTableName((astObj.table as unknown) || {});
      return {
        operation: type,
        normalizedSql,
        tables: table ? [{ table }] : [],
        joins: [],
        columns: [],
        confidence: table ? 0.85 : 0.7,
      };
    }

    return fallbackExtract(sql);
  } catch {
    return fallbackExtract(sql);
  }
}
