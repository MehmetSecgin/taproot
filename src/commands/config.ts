import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { printJson, renderTable } from '../core/output.js';
import {
  createSnapshot,
  diffAgainst,
  listSnapshots,
  pruneSnapshots,
  readHead,
  restoreSnapshot,
  statusAgainst,
} from '../core/config-snapshots.js';

const DEFAULT_DIFF_LINES = 200;

export function registerConfig(program: Command, getCtx: () => AppContext): void {
  const c = program.command('config').description('Version, inspect, and restore taproot config snapshots');

  c.command('snapshot')
    .description('Capture the current config directory as a restorable snapshot')
    .option('--label <label>', 'short label (e.g. known-good)')
    .option('--message <message>', 'description of this snapshot')
    .action((opts) => {
      const ctx = getCtx();
      const meta = createSnapshot(ctx.paths.configDir, ctx.paths.configSnapshotsDir, {
        label: opts.label,
        message: opts.message,
      });
      const summary = { id: meta.id, createdAt: meta.createdAt, label: meta.label, message: meta.message, files: meta.files.length };
      if (ctx.jsonMode) printJson({ snapshot: summary });
      else console.log(`snapshot ${meta.id} (${meta.files.length} files)${meta.label ? ` [${meta.label}]` : ''}`);
    });

  c.command('list')
    .description('List config snapshots, newest last')
    .action(() => {
      const ctx = getCtx();
      const snaps = listSnapshots(ctx.paths.configSnapshotsDir);
      const head = readHead(ctx.paths.configSnapshotsDir);
      const status = statusAgainst(ctx.paths.configDir, ctx.paths.configSnapshotsDir);
      if (ctx.jsonMode) {
        printJson({
          head,
          drifted: status.drifted,
          snapshots: snaps.map((s) => ({ id: s.id, createdAt: s.createdAt, label: s.label, message: s.message, files: s.files.length, head: s.id === head })),
        });
        return;
      }
      if (!snaps.length) {
        console.log('no config snapshots yet — run `taproot config snapshot`');
        return;
      }
      const rows = snaps.map((s) => ({ '': s.id === head ? '*' : '', id: s.id, createdAt: s.createdAt, label: s.label || '', files: s.files.length, message: s.message || '' }));
      console.log(renderTable(rows));
      console.log(`\n* = baseline (HEAD). ${status.drifted ? `current config has drifted (${status.changes.length} file(s)) — see \`taproot config diff\`` : 'current config is clean.'}`);
    });

  c.command('status')
    .description('Report whether the current config has drifted from a snapshot (default: latest)')
    .option('--id <id>', 'compare against a specific snapshot instead of the latest')
    .action((opts) => {
      const ctx = getCtx();
      const report = statusAgainst(ctx.paths.configDir, ctx.paths.configSnapshotsDir, opts.id);
      if (ctx.jsonMode) {
        printJson(report);
        return;
      }
      if (!report.baseline) {
        console.log('no config snapshots yet — run `taproot config snapshot`');
        return;
      }
      if (!report.drifted) {
        console.log(`clean — config matches snapshot ${report.baseline}`);
        return;
      }
      console.log(`drifted from snapshot ${report.baseline}:`);
      for (const ch of report.changes) console.log(`  ${ch.status.padEnd(8)} ${ch.file}`);
    });

  c.command('diff')
    .description('Show line-level differences between the current config and a snapshot (default: latest)')
    .option('--id <id>', 'diff against a specific snapshot instead of the latest')
    .option('--max-lines <n>', 'cap diff lines printed per file', String(DEFAULT_DIFF_LINES))
    .action((opts) => {
      const ctx = getCtx();
      const result = diffAgainst(ctx.paths.configDir, ctx.paths.configSnapshotsDir, opts.id);
      if (ctx.jsonMode) {
        printJson(result);
        return;
      }
      if (!result.files.length) {
        console.log(`clean — config matches snapshot ${result.baseline}`);
        return;
      }
      const cap = Number(opts.maxLines) || DEFAULT_DIFF_LINES;
      console.log(`diff vs snapshot ${result.baseline}:`);
      for (const f of result.files) {
        console.log(`\n${f.file} (${f.status}, +${f.added} -${f.removed})`);
        const shown = f.lines.slice(0, cap);
        for (const line of shown) console.log(`  ${line}`);
        if (f.lines.length > shown.length) console.log(`  … ${f.lines.length - shown.length} more line(s)`);
      }
    });

  c.command('restore')
    .description('Restore the config directory from a snapshot. Takes a pre-restore safety snapshot first.')
    .option('--id <id>', 'restore a specific snapshot')
    .option('--label <label>', 'restore the newest snapshot with this label')
    .option('--latest', 'restore the newest snapshot', false)
    .option('--no-backup', 'skip the pre-restore safety snapshot')
    .action((opts) => {
      const ctx = getCtx();
      if (!opts.id && !opts.label && !opts.latest) {
        throw new Error('Specify one of --id <id>, --label <label>, or --latest.');
      }
      const result = restoreSnapshot(
        ctx.paths.configDir,
        ctx.paths.configSnapshotsDir,
        { id: opts.id, label: opts.label, latest: opts.latest },
        { backup: opts.backup },
      );
      if (ctx.jsonMode) printJson(result);
      else {
        console.log(`restored config from snapshot ${result.restored}`);
        console.log(`  wrote ${result.written.length} file(s)${result.deleted.length ? `, removed ${result.deleted.length}` : ''}`);
        if (result.backup) console.log(`  pre-restore backup: ${result.backup}`);
      }
    });

  c.command('prune')
    .description('Delete old snapshots, keeping the most recent N')
    .option('--keep <n>', 'number of snapshots to keep', '20')
    .action((opts) => {
      const ctx = getCtx();
      const keep = Number(opts.keep);
      if (!Number.isInteger(keep) || keep < 0) throw new Error(`Invalid --keep '${opts.keep}'. Expected a non-negative integer.`);
      const removed = pruneSnapshots(ctx.paths.configSnapshotsDir, keep);
      if (ctx.jsonMode) printJson({ removed, kept: keep });
      else console.log(removed.length ? `pruned ${removed.length} snapshot(s), kept ${keep}` : `nothing to prune (keeping ${keep})`);
    });
}
