import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { printJson, printJsonPluck, renderTable } from '../core/output.js';
import { str } from '../core/strings.js';

function readSummary(runsDir: string, runId: string): Record<string, unknown> {
  const direct = path.join(runsDir, runId, 'summary.json');
  if (!fs.existsSync(direct)) {
    throw new Error(`Run summary not found: ${runId}`);
  }
  const raw = fs.readFileSync(direct, 'utf8');
  return JSON.parse(raw) as Record<string, unknown>;
}

function listRuns(runsDir: string, limit: number, datasource?: string): Array<{ runId: string; datasource: string; classification: string; durationMs: number | string; rowCount: number | string; }> {
  if (!fs.existsSync(runsDir)) return [];
  const entries = fs.readdirSync(runsDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
    .reverse();
  const out: Array<{ runId: string; datasource: string; classification: string; durationMs: number | string; rowCount: number | string }> = [];
  for (const runId of entries) {
    if (out.length >= limit) break;
    const summary = path.join(runsDir, runId, 'summary.json');
    if (!fs.existsSync(summary)) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(fs.readFileSync(summary, 'utf8')) as Record<string, unknown>;
    } catch {
      continue;
    }
    const ds = str(parsed.datasource);
    if (datasource && ds !== datasource) continue;
    const result = (parsed.result as Record<string, unknown> | undefined) || {};
    const timings = (parsed.timings as Record<string, unknown> | undefined) || {};
    const rows = typeof result.rowCount === 'number'
      ? result.rowCount
      : Array.isArray(result.rows) ? result.rows.length : '';
    out.push({
      runId,
      datasource: ds,
      classification: str(parsed.classification),
      durationMs: typeof timings.durationMs === 'number' ? (timings.durationMs as number) : '',
      rowCount: rows,
    });
  }
  return out;
}

export function registerRun(program: Command, getCtx: () => AppContext): void {
  const run = program.command('run').description('Inspect persisted run artifacts (no re-execution)');

  run.command('show')
    .description('Read the persisted summary for a prior run')
    .requiredOption('--run-id <id>')
    .option('--pluck <path>', 'return only the subtree at this dot-path (e.g. result.rows, meta.schemaContext, query.native)')
    .action((opts) => {
      const ctx = getCtx();
      const summary = readSummary(ctx.paths.runsDir, String(opts.runId));
      const pluck = opts.pluck ? String(opts.pluck) : undefined;
      printJsonPluck(summary, pluck);
      void ctx;
    });

  run.command('list')
    .description('List recent run artifacts')
    .option('--datasource <name>')
    .option('--limit <n>', 'max rows', '20')
    .action((opts) => {
      const ctx = getCtx();
      const limit = Math.max(1, Number(opts.limit || 20));
      const rows = listRuns(ctx.paths.runsDir, limit, opts.datasource ? String(opts.datasource) : undefined);
      if (ctx.jsonMode) {
        printJson(rows);
      } else {
        console.log(renderTable(rows));
      }
    });
}
