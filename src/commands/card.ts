import fs from 'node:fs';
import path from 'node:path';
import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { printJson, renderRecord, renderTable } from '../core/output.js';
import { promoteRunToCard } from '../core/card-promotion.js';
import { readRunsLedgerEntries, type RunsLedgerEntry } from '../core/runs-ledger.js';

function appendList(value: string, prior: string[] = []): string[] {
  return [...prior, value];
}

function cardSlug(value: string): string {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[`'"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96) || 'query';
}

function defaultOutputDir(stateRoot: string, datasource: string): string {
  return path.join(stateRoot, 'cards', cardSlug(datasource || 'datasource'));
}

function peekRunDatasource(runsDir: string, runId: string): string {
  const tryRead = (dir: string): string | undefined => {
    const summary = path.join(dir, 'summary.json');
    if (!fs.existsSync(summary)) return undefined;
    try {
      const parsed = JSON.parse(fs.readFileSync(summary, 'utf8')) as { datasource?: string };
      return parsed.datasource;
    } catch {
      return undefined;
    }
  };
  const direct = tryRead(path.join(runsDir, runId));
  if (direct) return direct;
  if (!fs.existsSync(runsDir)) return '';
  const match = fs.readdirSync(runsDir).find((entry) => entry === runId || entry.endsWith(runId) || entry.includes(runId));
  if (match) {
    const ds = tryRead(path.join(runsDir, match));
    if (ds) return ds;
  }
  return '';
}

interface Candidate {
  fingerprint: string;
  datasource: string;
  sessions: Set<string>;
  runIds: string[];
  sample: RunsLedgerEntry;
}

function aggregateCandidates(entries: RunsLedgerEntry[], opts: { minSessions: number; datasource?: string }): Candidate[] {
  const buckets = new Map<string, Candidate>();
  for (const entry of entries) {
    if (entry.outcomeCode !== 'ok') continue;
    if (!entry.sql || !entry.sql.trim()) continue;
    if (opts.datasource && entry.datasource !== opts.datasource) continue;
    let bucket = buckets.get(entry.fingerprint);
    if (!bucket) {
      bucket = { fingerprint: entry.fingerprint, datasource: entry.datasource, sessions: new Set(), runIds: [], sample: entry };
      buckets.set(entry.fingerprint, bucket);
    }
    bucket.sessions.add(entry.sessionId || entry.runId);
    bucket.runIds.push(entry.runId);
  }
  return [...buckets.values()]
    .filter((b) => b.sessions.size >= opts.minSessions)
    .sort((a, b) => b.sessions.size - a.sessions.size || b.runIds.length - a.runIds.length);
}

export function registerCard(program: Command, getCtx: () => AppContext): void {
  const card = program.command('card').description('Curated query card operations');

  card
    .command('list')
    .option('--datasource <name>')
    .action((opts) => {
      const ctx = getCtx();
      const rows = ctx.cardStore
        .list()
        .filter((item) => !opts.datasource || item.datasource === opts.datasource);
      if (ctx.jsonMode) printJson(rows);
      else {
        console.log(
          renderTable(
            rows.map((item) => ({
              id: item.id,
              datasource: item.datasource || '',
              intent: item.intent || '',
              tables: item.tables.join(', '),
              purpose: item.purpose,
            })),
          ),
        );
      }
    });

  card
    .command('show')
    .argument('<id>')
    .action((id) => {
      const ctx = getCtx();
      const item = ctx.cardStore.get(id);
      if (!item) throw new Error(`Query card not found: ${id}`);
      if (ctx.jsonMode) printJson(item);
      else console.log(renderRecord(item as unknown as Record<string, unknown>));
    });

  card
    .command('validate')
    .argument('<path>')
    .action((filePath) => {
      const ctx = getCtx();
      const item = ctx.cardStore.validateFile(filePath);
      if (ctx.jsonMode) printJson({ ok: true, card: item });
      else console.log(`valid query card: ${item.id}`);
    });

  card
    .command('save')
    .description('Save a single successful run as a curated query card YAML (manual gate)')
    .argument('<runId>')
    .option('--id <id>', 'Override generated card id')
    .option('--purpose <text>', 'Human description of why this query exists')
    .option('--intent <intent>', 'Short intent tag (e.g. recent-orders)')
    .option('--alias <a>', 'Add an alias (repeatable)', appendList, [] as string[])
    .option('--owner <o>', 'Add an owner (repeatable)', appendList, [] as string[])
    .option('--output-dir <dir>', 'Override output directory (default <stateRoot>/cards/<datasource>)')
    .option('--overwrite', 'Overwrite an existing card file', false)
    .option('--dry-run', 'Print the YAML without writing', false)
    .action((runId, opts) => {
      const ctx = getCtx();
      const datasource = peekRunDatasource(ctx.paths.runsDir, runId);
      const outputDir = opts.outputDir
        ? path.resolve(opts.outputDir)
        : defaultOutputDir(ctx.paths.stateRoot, datasource);
      const result = promoteRunToCard({
        runsDir: ctx.paths.runsDir,
        runId,
        id: opts.id,
        purpose: opts.purpose,
        intent: opts.intent,
        aliases: opts.alias,
        owners: opts.owner,
        outputDir,
        overwrite: Boolean(opts.overwrite),
        dryRun: Boolean(opts.dryRun),
      });
      if (ctx.jsonMode) {
        printJson({ wrote: result.wrote, path: result.path, card: result.card });
      } else if (opts.dryRun) {
        console.log(`(dry-run) would write ${result.path}\n`);
        console.log(result.yaml);
      } else {
        console.log(`Saved card '${result.card.id}' -> ${result.path}`);
        console.log(`Next: 'taproot idea cards sync' to push to your IDEA project.`);
      }
    });

  card
    .command('list-candidates')
    .description('Successful query fingerprints worth promoting (from runs ledger)')
    .option('--min-sessions <n>', 'Distinct sessions threshold', '2')
    .option('--datasource <name>', 'Limit to one datasource')
    .option('--limit <n>', 'Max rows', '20')
    .option('--ledger-limit <n>', 'Max ledger entries to scan', '2000')
    .action((opts) => {
      const ctx = getCtx();
      const minSessions = Math.max(1, Number.parseInt(String(opts.minSessions), 10) || 2);
      const ledgerLimit = Math.max(50, Number.parseInt(String(opts.ledgerLimit), 10) || 2000);
      const entries = readRunsLedgerEntries(ctx.paths.runsLedgerDir, ledgerLimit);
      const candidates = aggregateCandidates(entries, { minSessions, datasource: opts.datasource });
      const limit = Math.max(1, Number.parseInt(String(opts.limit), 10) || 20);
      const rows = candidates.slice(0, limit).map((c) => ({
        runId: c.sample.runId,
        sessions: c.sessions.size,
        runs: c.runIds.length,
        datasource: c.datasource,
        intent: c.sample.intent || '',
        tables: c.sample.tables.join(',') || '',
        preview: String(c.sample.sql).replace(/\s+/g, ' ').slice(0, 80),
      }));
      if (ctx.jsonMode) printJson({ minSessions, total: candidates.length, rows });
      else {
        console.log(renderTable(rows));
        if (rows.length) console.log(`\nPromote one: taproot card save <runId> --id <slug> --purpose "..."`);
      }
    });
}

export const __test__ = { aggregateCandidates };
