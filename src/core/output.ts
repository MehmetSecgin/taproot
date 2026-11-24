import { pluckPath } from './dot-path.js';
import { isList, isRecord } from './json-shapes.js';
import type { QueryPhaseTimings } from '../types/plugin.js';
import type { SchemaContext } from '../types/schema-context.js';

export type CliOutputEnvelope<Data = unknown> = {
  ok: boolean;
  data?: Data;
  meta?: {
    requestId?: string;
    sessionId?: string;
    schemaContext?: SchemaContext;
    timings?: {
      durationMs: number;
    };
    phases?: QueryPhaseTimings;
  };
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
};

type OutputOptions = {
  pluckPath: string | undefined;
  lines: boolean;
};

const outputOptions: OutputOptions = { pluckPath: undefined, lines: false };

export function setPluck(path?: string): void {
  outputOptions.pluckPath = path;
}

export function setLines(enabled: boolean): void {
  outputOptions.lines = enabled;
}

function isFailureEnvelope(data: unknown): boolean {
  return isRecord(data) && data.ok === false;
}

function nonEmptyWarnings(container: unknown): unknown[] | undefined {
  const warnings = isRecord(container) ? container.warnings : undefined;
  return isList(warnings) && warnings.length > 0 ? warnings : undefined;
}

function listEnvelopeLines(envelope: Record<string, unknown>, items: unknown[]): unknown[] {
  const warnings = nonEmptyWarnings(envelope.meta);
  return [warnings === undefined ? { ok: true } : { ok: true, warnings }, ...items];
}

function rowSetLines(rowSet: Record<string, unknown>, rows: unknown[]): unknown[] {
  const header: Record<string, unknown> = { ok: true, columns: rowSet.columns };
  if (rowSet.truncated === true) {
    header.truncated = true;
  }
  const warnings = nonEmptyWarnings(rowSet);
  if (warnings !== undefined) {
    header.warnings = warnings;
  }
  return [header, ...rows];
}

export function envelopeToLines(value: unknown): unknown[] {
  if (isList(value)) {
    return value;
  }
  if (!isRecord(value) || value.ok !== true) {
    return [value];
  }
  if (isList(value.data)) {
    return listEnvelopeLines(value, value.data);
  }
  if (!isRecord(value.data) || !isList(value.data.rows)) {
    return [value];
  }
  return rowSetLines(value.data, value.data.rows);
}

function applyPluck(data: unknown): unknown {
  const path = outputOptions.pluckPath;
  if (path === undefined || path === '' || isFailureEnvelope(data)) {
    return data;
  }
  return pluckPath(data, path);
}

function toPrintedLines(value: unknown): unknown[] {
  return outputOptions.lines && !isFailureEnvelope(value) ? envelopeToLines(value) : [value];
}

export function printJson(data: unknown): void {
  const lines = toPrintedLines(applyPluck(data));
  process.stdout.write(lines.map((line) => `${JSON.stringify(line) ?? 'null'}\n`).join(''));
}

type EnvelopeMeta = CliOutputEnvelope['meta'] & Record<string, unknown>;

export function printSuccess(data: unknown, meta?: EnvelopeMeta): void {
  printJson({ ok: true, data, meta });
}

export function printFailure(error: CliOutputEnvelope['error'], meta?: EnvelopeMeta): void {
  printJson({ ok: false, error, meta });
}
