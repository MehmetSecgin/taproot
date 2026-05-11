import type { CliOutputEnvelope } from '../types/core.js';
import Table from 'cli-table3';

export type DatetimeFormat = 'iso' | 'js' | 'epoch';

function datetimeFormat(): DatetimeFormat {
  const raw = String(process.env.TAPROOT_DATETIME_FORMAT || '').trim().toLowerCase();
  if (raw === 'js' || raw === 'epoch') return raw;
  return 'iso';
}

function formatDate(value: Date): string {
  switch (datetimeFormat()) {
    case 'js':
      return value.toString();
    case 'epoch':
      return String(value.getTime());
    case 'iso':
    default:
      return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }
}

export function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function pluckPath(obj: unknown, path: string): unknown {
  const trimmed = String(path || '').trim();
  if (!trimmed) return obj;
  const parts = trimmed.split('.').filter(Boolean);
  let cur: unknown = obj;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    const arrayMatch = part.match(/^(\w*)\[(\d+)\]$/);
    if (arrayMatch) {
      const key = arrayMatch[1];
      const idx = Number(arrayMatch[2]);
      if (key) {
        cur = (cur as Record<string, unknown>)[key];
        if (cur === null || cur === undefined) return undefined;
      }
      if (!Array.isArray(cur)) return undefined;
      cur = cur[idx];
      continue;
    }
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function printJsonPluck(data: unknown, path?: string): void {
  if (!path) {
    printJson(data);
    return;
  }
  printJson(pluckPath(data, path));
}

export function printEnvelope(
  ok: boolean,
  data: unknown,
  error?: CliOutputEnvelope['error'],
  meta?: CliOutputEnvelope['meta'],
): void {
  const env: CliOutputEnvelope = { ok, data, error, meta };
  printJson(env);
}

function formatValue(value: unknown): string {
  if (value == null) return '';
  if (value instanceof Date) return formatDate(value);
  if (Buffer.isBuffer(value)) return value.toString('base64');
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((v) => formatValue(v)).join(', ');
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export function renderTable(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return 'Rows: 0\n(no rows)';
  const columns = Object.keys(rows[0]);
  const table = new Table({
    head: columns,
    wordWrap: true,
  });
  for (const row of rows) {
    table.push(columns.map((column) => formatValue(row[column])));
  }
  return `Rows: ${rows.length}\n\n${table.toString()}`;
}

export const DEFAULT_BIG_RESULT_THRESHOLD_BYTES = 32 * 1024;
export const DEFAULT_BIG_RESULT_SAMPLE_SIZE = 10;

export interface RenderTableSmartOptions {
  full?: boolean;
  thresholdBytes?: number;
  sampleSize?: number;
}

export function renderTableSummary(
  rows: Array<Record<string, unknown>>,
  options: { sampleSize?: number } = {},
): string {
  const sampleSize = options.sampleSize ?? DEFAULT_BIG_RESULT_SAMPLE_SIZE;
  if (!rows.length) return 'Rows: 0\n(no rows)';
  const columns = Object.keys(rows[0]);
  const distinctRows = columns.map((column) => {
    const seen = new Set<string>();
    for (const row of rows) seen.add(formatValue(row[column]));
    return { column, distinct: seen.size };
  });
  const sample = rows.slice(0, sampleSize);
  const header = `Rows: ${rows.length} (large result, summarized — pass --full to dump everything)`;
  const distinctBlock = `Distinct values per column:\n${renderTable(distinctRows)}`;
  const sampleBlock = `First ${sample.length} rows:\n${renderTable(sample)}`;
  return `${header}\n\n${distinctBlock}\n\n${sampleBlock}`;
}

export function renderTableSmart(
  rows: Array<Record<string, unknown>>,
  options: RenderTableSmartOptions = {},
): string {
  const full = options.full ?? false;
  const threshold = options.thresholdBytes ?? DEFAULT_BIG_RESULT_THRESHOLD_BYTES;
  const rendered = renderTable(rows);
  if (full || Buffer.byteLength(rendered, 'utf8') <= threshold) return rendered;
  return renderTableSummary(rows, { sampleSize: options.sampleSize });
}

export function renderRecord(record: Record<string, unknown>): string {
  const rows = Object.entries(record).map(([key, value]) => ({ key, value: formatValue(value) }));
  return renderTable(rows);
}
