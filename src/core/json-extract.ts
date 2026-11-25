import { badInput } from './taproot-error.js';
import { pluckPath } from './dot-path.js';

export type JsonExtractSpec = {
  column: string;
  path: string;
  outputColumn: string;
};

type ExtractedTable = {
  columns: string[];
  rows: unknown[][];
};

function invalidSpecError(rawSpec: string): Error {
  return badInput(`invalid --json-extract '${rawSpec}'. Expected '<column>:<dotpath>' (e.g. payload:order.id).`);
}

function splitColumnAndPath(rawSpec: string, text: string): JsonExtractSpec {
  const separator = text.indexOf(':');
  const column = separator > 0 ? text.slice(0, separator).trim() : '';
  const path = separator > 0 ? text.slice(separator + 1).trim() : '';
  if (column === '' || path === '') {
    throw invalidSpecError(rawSpec);
  }
  return { column, path, outputColumn: `${column}.${path}` };
}

function parseJsonExtractSpec(rawSpec: string): JsonExtractSpec | undefined {
  const text = rawSpec.trim();
  return text === '' ? undefined : splitColumnAndPath(rawSpec, text);
}

export function parseJsonExtractSpecs(values?: string[]): JsonExtractSpec[] {
  const specs: JsonExtractSpec[] = [];
  for (const rawSpec of values ?? []) {
    const spec = parseJsonExtractSpec(rawSpec);
    if (spec !== undefined) {
      specs.push(spec);
    }
  }
  return specs;
}

function parseJsonCell(cell: unknown): unknown {
  if (typeof cell !== 'string' && !Buffer.isBuffer(cell)) {
    return cell;
  }
  const text = typeof cell === 'string' ? cell.trim() : cell.toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function extractFromCell(cell: unknown, path: string): unknown {
  if (cell === null || cell === undefined) {
    return null;
  }
  return pluckPath(parseJsonCell(cell), path) ?? null;
}

function assertSourceColumnsPresent(columns: string[], specs: JsonExtractSpec[]): void {
  const missing = specs.filter((spec) => !columns.includes(spec.column));
  if (missing.length > 0) {
    throw badInput(
      `--json-extract references column(s) not present in the result: ${missing
        .map((spec) => spec.column)
        .join(', ')}. Available columns: ${columns.join(', ') || '(none)'}.`,
    );
  }
}

function withOutputColumns(columns: string[], specs: JsonExtractSpec[]): string[] {
  const allColumns = [...columns];
  for (const spec of specs) {
    if (!allColumns.includes(spec.outputColumn)) {
      allColumns.push(spec.outputColumn);
    }
  }
  return allColumns;
}

export function applyJsonExtract(columns: string[], rows: unknown[][], specs: JsonExtractSpec[]): ExtractedTable {
  if (specs.length === 0) {
    return { columns, rows };
  }
  assertSourceColumnsPresent(columns, specs);
  const allColumns = withOutputColumns(columns, specs);
  const extractions = specs.map((spec) => ({
    source: columns.indexOf(spec.column),
    target: allColumns.indexOf(spec.outputColumn),
    path: spec.path,
  }));
  const extractedRows = rows.map((row) => {
    const extendedRow = [...row];
    for (const { source, target, path } of extractions) {
      extendedRow[target] = extractFromCell(row[source], path);
    }
    return extendedRow;
  });
  return { columns: allColumns, rows: extractedRows };
}
