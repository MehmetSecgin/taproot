import { badInput } from './error-classification.js';
import { pluckPath } from './output.js';
import { str } from './strings.js';

export interface JsonExtractSpec {
  column: string;
  path: string;
  alias: string;
}

export function parseJsonExtractSpecs(values: string[] | undefined): JsonExtractSpec[] {
  const specs: JsonExtractSpec[] = [];
  for (const raw of values || []) {
    const text = str(raw).trim();
    if (!text) continue;
    const sep = text.indexOf(':');
    if (sep <= 0) {
      throw badInput(`invalid --json-extract '${raw}'. Expected '<column>:<dotpath>' (e.g. payload:order.id).`);
    }
    const column = text.slice(0, sep).trim();
    const path = text.slice(sep + 1).trim();
    if (!column || !path) {
      throw badInput(`invalid --json-extract '${raw}'. Expected '<column>:<dotpath>' (e.g. payload:order.id).`);
    }
    specs.push({ column, path, alias: `${column}.${path}` });
  }
  return specs;
}

function extractFromCell(cell: unknown, path: string): unknown {
  if (cell === null || cell === undefined) return null;
  let parsed: unknown = cell;
  if (typeof cell === 'string') {
    const trimmed = cell.trim();
    if (!trimmed) return null;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return null;
    }
  } else if (Buffer.isBuffer(cell)) {
    try {
      parsed = JSON.parse(cell.toString('utf8'));
    } catch {
      return null;
    }
  }
  const value = pluckPath(parsed, path);
  return value === undefined ? null : value;
}

export function applyJsonExtract(
  columns: string[],
  rows: Array<Record<string, unknown>>,
  specs: JsonExtractSpec[],
): { columns: string[]; rows: Array<Record<string, unknown>> } {
  if (!specs.length) return { columns, rows };
  const missing = specs.filter((spec) => !columns.includes(spec.column));
  if (missing.length) {
    throw badInput(
      `--json-extract references column(s) not present in the result: ${missing
        .map((spec) => spec.column)
        .join(', ')}. Available columns: ${columns.join(', ') || '(none)'}.`,
    );
  }
  const nextColumns = [...columns];
  for (const spec of specs) {
    if (!nextColumns.includes(spec.alias)) nextColumns.push(spec.alias);
  }
  const nextRows = rows.map((row) => {
    const out: Record<string, unknown> = { ...row };
    for (const spec of specs) out[spec.alias] = extractFromCell(row[spec.column], spec.path);
    return out;
  });
  return { columns: nextColumns, rows: nextRows };
}
