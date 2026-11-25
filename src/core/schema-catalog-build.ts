import type { SchemaIndex, SchemaPartition, TableContext } from '../types/schema-context.js';
import { textUnlessFalsy } from './text-presence.js';

export type CatalogRow = Record<string, unknown>;

export type CatalogRows = {
  columns: CatalogRow[];
  indexes: CatalogRow[];
  partitions: CatalogRow[];
};

type CsvSplit = { depth: number; current: string; parts: string[] };

type IndexColumnRow = { row: CatalogRow; name: string; column: string };

const PLAIN_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/u;
const IDENTIFIER_RE = /\b[a-zA-Z_][a-zA-Z0-9_]*\b/gu;
const BACKTICK_COLUMN_RE = /`(?<column>[^`]+)`/gu;
const PARTITION_FUNCTION_OR_KEYWORD_RE = /^(?:to_days|unix_timestamp|year|month|day|date|range|list|columns)$/iu;
const WHITESPACE_RE = /\s+/u;
const UNIQUE_NON_UNIQUE_VALUES = new Set<unknown>([0, '0', 0n]);
const DEFAULT_INDEX_TYPE = 'BTREE';
const PRIMARY_INDEX_NAME = 'PRIMARY';

function cell(row: CatalogRow, column: string): string {
  return textUnlessFalsy(row[column]).trim();
}

function firstCell(row: CatalogRow, columns: string[]): string {
  const texts = columns.map((column) => textUnlessFalsy(row[column]));
  return (texts.find((text) => text !== '') ?? '').trim();
}

function backtickColumns(expression: string): string[] {
  return [...expression.matchAll(BACKTICK_COLUMN_RE)].map((match) => match.groups?.column ?? '');
}

function nextParenthesisDepth(depth: number, char: string): number {
  if (char === '(') {
    return depth + 1;
  }
  return char === ')' ? Math.max(0, depth - 1) : depth;
}

function consumeChar(split: CsvSplit, char: string): void {
  if (char === ',' && split.depth === 0) {
    split.parts.push(split.current.trim());
    split.current = '';
    return;
  }
  split.depth = nextParenthesisDepth(split.depth, char);
  split.current += char;
}

function splitTopLevelCsv(value: string): string[] {
  const split: CsvSplit = { depth: 0, current: '', parts: [] };
  for (const char of value) {
    consumeChar(split, char);
  }
  if (split.current.trim() !== '') {
    split.parts.push(split.current.trim());
  }
  return split.parts;
}

function partitionKeyOfExpressionPart(part: string): string | undefined {
  const stripped = part.replaceAll('`', '').trim();
  if (PLAIN_IDENTIFIER_RE.test(stripped)) {
    return stripped;
  }
  const quotedColumns = backtickColumns(part);
  if (quotedColumns.length === 1) {
    return quotedColumns[0];
  }
  const identifiers = [...stripped.matchAll(IDENTIFIER_RE)]
    .map((match) => match[0])
    .filter((identifier) => !PARTITION_FUNCTION_OR_KEYWORD_RE.test(identifier));
  return identifiers.length === 1 ? identifiers[0] : undefined;
}

function derivePartitionKeys(expression: string): string[] {
  const keys = splitTopLevelCsv(expression)
    .map((part) => partitionKeyOfExpressionPart(part))
    .filter((key) => key !== undefined);
  return [...new Set(keys)];
}

function parsePartition(rawMethod: string, rawExpression: string): SchemaPartition | undefined {
  const kind = rawMethod.trim().split(WHITESPACE_RE)[0]?.toUpperCase();
  const expr = rawExpression.trim();
  if (kind === undefined || kind === '' || expr === '') {
    return undefined;
  }
  const keys = derivePartitionKeys(expr);
  return { kind, expr, keys, key: keys.length === 1 ? keys[0] : undefined };
}

function groupColumnsByTable(rows: CatalogRow[]): Map<string, Set<string>> {
  const columnsByTable = new Map<string, Set<string>>();
  for (const row of rows) {
    const table = cell(row, 'table_name');
    const column = cell(row, 'column_name');
    if (table !== '') {
      const columns = columnsByTable.get(table) ?? new Set<string>();
      if (column !== '') {
        columns.add(column);
      }
      columnsByTable.set(table, columns);
    }
  }
  return columnsByTable;
}

function addIndexColumn(indexes: Map<string, SchemaIndex>, { row, name, column }: IndexColumnRow): void {
  const index = indexes.get(name) ?? { name, columns: [] };
  if (UNIQUE_NON_UNIQUE_VALUES.has(row.non_unique ?? '1')) {
    index.unique = true;
  }
  const type = cell(row, 'index_type');
  if (type !== '' && type.toUpperCase() !== DEFAULT_INDEX_TYPE) {
    index.type = type;
  }
  index.columns.push(column);
  indexes.set(name, index);
}

function groupIndexesByTable(rows: CatalogRow[]): Map<string, Map<string, SchemaIndex>> {
  const indexesByTable = new Map<string, Map<string, SchemaIndex>>();
  for (const row of rows) {
    const table = cell(row, 'table_name');
    const name = cell(row, 'index_name');
    const column = cell(row, 'column_name');
    if (table !== '' && name !== '' && column !== '') {
      const indexes = indexesByTable.get(table) ?? new Map<string, SchemaIndex>();
      addIndexColumn(indexes, { row, name, column });
      indexesByTable.set(table, indexes);
    }
  }
  return indexesByTable;
}

function firstPartitionByTable(rows: CatalogRow[]): Map<string, SchemaPartition> {
  const partitionsByTable = new Map<string, SchemaPartition>();
  for (const row of rows) {
    const table = cell(row, 'table_name');
    if (table !== '' && !partitionsByTable.has(table)) {
      const partition = parsePartition(
        firstCell(row, ['partition_method', 'subpartition_method']),
        firstCell(row, ['partition_expression', 'subpartition_expression']),
      );
      if (partition !== undefined) {
        partitionsByTable.set(table, partition);
      }
    }
  }
  return partitionsByTable;
}

export function buildCatalogTables(rows: CatalogRows, database: string): Record<string, TableContext> {
  const columnsByTable = groupColumnsByTable(rows.columns);
  const indexesByTable = groupIndexesByTable(rows.indexes);
  const partitionsByTable = firstPartitionByTable(rows.partitions);
  const tables: Record<string, TableContext> = {};
  for (const [table, columns] of [...columnsByTable.entries()].toSorted(([left], [right]) => left.localeCompare(right))) {
    const indexes = [...(indexesByTable.get(table)?.values() ?? [])];
    tables[table] = {
      database,
      columns: [...columns],
      primaryKey: indexes.find((index) => index.name === PRIMARY_INDEX_NAME)?.columns ?? [],
      indexes,
      partition: partitionsByTable.get(table),
    };
  }
  return tables;
}
