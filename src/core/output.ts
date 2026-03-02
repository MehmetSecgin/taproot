import type { CliOutputEnvelope } from '../types/core.js';
import Table from 'cli-table3';

export function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function printEnvelope(ok: boolean, data: unknown, error?: CliOutputEnvelope['error']): void {
  const env: CliOutputEnvelope = { ok, data, error };
  printJson(env);
}

export function renderTable(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return 'Rows: 0\n(no rows)';
  const columns = Object.keys(rows[0]);
  const table = new Table({
    head: columns,
    wordWrap: true,
  });
  for (const row of rows) {
    table.push(columns.map((column) => String(row[column] ?? '')));
  }
  return `Rows: ${rows.length}\n\n${table.toString()}`;
}
