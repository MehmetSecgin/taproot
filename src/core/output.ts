import type { CliOutputEnvelope } from '../types/core.js';

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
  const widths = columns.map((c) => c.length);
  for (const row of rows) {
    columns.forEach((c, i) => {
      const v = String(row[c] ?? '');
      widths[i] = Math.max(widths[i], v.length);
    });
  }
  const border = `+${widths.map((w) => '-'.repeat(w + 2)).join('+')}+`;
  const fmt = (vals: string[]) => `|${vals.map((v, i) => ` ${v.padEnd(widths[i], ' ')} `).join('|')}|`;
  const lines = [`Rows: ${rows.length}`, '', border, fmt(columns), border];
  for (const row of rows) lines.push(fmt(columns.map((c) => String(row[c] ?? ''))));
  lines.push(border);
  return lines.join('\n');
}
