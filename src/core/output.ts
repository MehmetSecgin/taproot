import type { CliOutputEnvelope } from '../types/core.js';
import { str } from './strings.js';

let pluck: string | undefined;

export function setPluck(path?: string): void {
  pluck = path;
}

function isErrorEnvelope(data: unknown): boolean {
  const env = data as { ok?: unknown } | null;
  return Boolean(env && typeof env === 'object' && env.ok === false);
}

export function printJson(data: unknown): void {
  const value = pluck && !isErrorEnvelope(data) ? pluckPath(data, pluck) : data;
  process.stdout.write(`${JSON.stringify(value) ?? 'null'}\n`);
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
