import type { CliOutputEnvelope } from '../types/core.js';
import Table from 'cli-table3';
import { str } from './strings.js';

export type DatetimeFormat = 'iso' | 'js' | 'epoch';

function datetimeFormat(): DatetimeFormat {
  const raw = str(process.env.TAPROOT_DATETIME_FORMAT).trim().toLowerCase();
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

export function rowToObject(columns: string[], row: unknown): Record<string, unknown> {
  if (Array.isArray(row)) {
    const out: Record<string, unknown> = {};
    columns.forEach((c, i) => {
      out[c] = row[i];
    });
    return out;
  }
  const source = (row && typeof row === 'object' ? row : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const c of columns) out[c] = source[c];
  return out;
}

export function renderSchemaContextFooter(schemaContext: unknown): string | null {
  const sc = schemaContext as
    | { tables?: Record<string, unknown>; services?: Record<string, unknown>; messages?: Record<string, unknown>; relations?: unknown[] }
    | undefined;
  if (!sc) return null;
  const relations = Array.isArray(sc.relations) ? sc.relations.length : 0;
  const relationSuffix = relations ? `, ${relations} relation${relations === 1 ? '' : 's'}` : '';
  const tables = Object.keys(sc.tables || {}).length;
  if (tables) return `[schemaContext: ${tables} table${tables === 1 ? '' : 's'} cached${relationSuffix} — pass --json for full detail]`;
  const services = Object.keys(sc.services || {}).length;
  const messages = Object.keys(sc.messages || {}).length;
  if (services || messages) {
    return `[schemaContext: ${services} service${services === 1 ? '' : 's'}, ${messages} message${messages === 1 ? '' : 's'} — pass --json for full detail]`;
  }
  if (relations) return `[schemaContext: ${relations} relation${relations === 1 ? '' : 's'} — pass --json for full detail]`;
  return null;
}

export interface OutputOptions {
  pluck?: string;
  jsonl: boolean;
}

let outputOptions: OutputOptions = { jsonl: false };

export function setOutputOptions(options: OutputOptions): void {
  outputOptions = options;
}

export function getOutputOptions(): OutputOptions {
  return outputOptions;
}

function envelopeError(data: unknown): Record<string, unknown> | undefined {
  const env = data as { ok?: unknown; error?: unknown } | null;
  if (!env || typeof env !== 'object' || env.ok !== false || !env.error) return undefined;
  return typeof env.error === 'object' ? (env.error as Record<string, unknown>) : { message: String(env.error) };
}

function errorLine(error: Record<string, unknown>): string {
  const code = str(error.code);
  const message = str(error.message);
  const head = !code || message.toLowerCase().startsWith(`${code.toLowerCase()}:`) ? message : `${code}: ${message}`;
  const next = str((error.details as { nextAction?: unknown } | undefined)?.nextAction);
  return next ? `${head}\nnextAction: ${next}\n` : `${head}\n`;
}

function jsonLines(value: unknown): string {
  if (value === undefined) return '';
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => `${JSON.stringify(item)}\n`).join('');
}

export function printJson(data: unknown): void {
  const { pluck, jsonl } = outputOptions;
  const error = envelopeError(data);
  if (error && jsonl) {
    process.stderr.write(errorLine(error));
    return;
  }
  if (error && pluck) {
    process.stderr.write(`${JSON.stringify(error, null, 2)}\n`);
    return;
  }
  const value = pluck ? pluckPath(data, pluck) : data;
  if (!jsonl) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    return;
  }
  const unwrapped = !pluck && (value as { ok?: unknown } | null)?.ok === true ? (value as { data?: unknown }).data : value;
  process.stdout.write(jsonLines(unwrapped));
}

export function pluckPath(obj: unknown, path: string): unknown {
  const trimmed = str(path).trim();
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

function isEmptyMap(value: unknown): boolean {
  return !value || typeof value !== 'object' || Object.keys(value as Record<string, unknown>).length === 0;
}

export function trimQueryJsonEnvelope<T extends Record<string, unknown>>(envelope: T): T {
  const data = envelope.data as Record<string, unknown> | undefined;
  if (data && typeof data === 'object') {
    if ('queryMemory' in data && isEmptyMap(data.queryMemory)) delete data.queryMemory;
    if (Array.isArray(data.warnings) && data.warnings.length === 0) delete data.warnings;
  }
  const meta = envelope.meta as Record<string, unknown> | undefined;
  if (meta && typeof meta === 'object') {
    if ('queryMemory' in meta && isEmptyMap(meta.queryMemory)) delete meta.queryMemory;
    const sc = meta.schemaContext as Record<string, unknown> | undefined;
    if (
      sc &&
      isEmptyMap(sc.tables) &&
      isEmptyMap(sc.services) &&
      isEmptyMap(sc.messages) &&
      isEmptyMap(sc.enums) &&
      !(Array.isArray(sc.relations) && sc.relations.length)
    ) delete meta.schemaContext;
  }
  return envelope;
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

export function respondOk<T = unknown>(data: T, meta?: Record<string, unknown>): void {
  printJson({ ok: true, data, meta: meta || {} });
}

export function respondErr(
  code: string,
  message: string,
  details?: unknown,
  meta?: Record<string, unknown>,
): void {
  printJson({ ok: false, error: { code, message, details }, meta: meta || {} });
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

export function renderTable(rows: ReadonlyArray<object>): string {
  if (!rows.length) return 'Rows: 0\n(no rows)';
  const columns = Object.keys(rows[0] as Record<string, unknown>);
  const table = new Table({
    head: columns,
    wordWrap: true,
  });
  for (const row of rows) {
    table.push(columns.map((column) => formatValue((row as Record<string, unknown>)[column])));
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
