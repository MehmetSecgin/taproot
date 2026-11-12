import type { CliOutputEnvelope } from '../types/core.js';
import { str } from './strings.js';

let pluck: string | undefined;
let lines = false;

export function setPluck(path?: string): void {
  pluck = path;
}

export function setLines(enabled: boolean): void {
  lines = enabled;
}

function isErrorEnvelope(data: unknown): boolean {
  const env = data as { ok?: unknown } | null;
  return Boolean(env && typeof env === 'object' && env.ok === false);
}

export function printJson(data: unknown): void {
  const value = pluck && !isErrorEnvelope(data) ? pluckPath(data, pluck) : data;
  const out = lines && !isErrorEnvelope(value) ? toLines(value) : [value];
  process.stdout.write(out.map((line) => `${JSON.stringify(line) ?? 'null'}\n`).join(''));
}

export function toLines(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const env = value as { ok?: unknown; data?: unknown; meta?: { warnings?: unknown } } | null;
  if (!env || typeof env !== 'object' || env.ok !== true) return [value];
  if (Array.isArray(env.data)) {
    const warnings = env.meta?.warnings;
    return [Array.isArray(warnings) && warnings.length ? { ok: true, warnings } : { ok: true }, ...env.data];
  }
  const data = env.data as { columns?: unknown; rows?: unknown; warnings?: unknown } | undefined;
  if (!data || !Array.isArray(data.rows)) return [value];
  const header: Record<string, unknown> = { ok: true, columns: data.columns };
  if (Array.isArray(data.warnings) && data.warnings.length) header.warnings = data.warnings;
  return [header, ...data.rows];
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
    if (Array.isArray(data.warnings) && data.warnings.length === 0) delete data.warnings;
  }
  const meta = envelope.meta as Record<string, unknown> | undefined;
  if (meta && typeof meta === 'object') {
    const sc = meta.schemaContext as Record<string, unknown> | undefined;
    if (sc && isEmptyMap(sc.tables)) delete meta.schemaContext;
  }
  return envelope;
}

export function printEnvelope(
  ok: boolean,
  data: unknown,
  error?: CliOutputEnvelope['error'],
  meta?: CliOutputEnvelope['meta'] & Record<string, unknown>,
): void {
  const env: CliOutputEnvelope = { ok, data, error, meta };
  printJson(env);
}
