import type { CliOutputEnvelope } from '../types/core.js';
import { str } from './strings.js';

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
