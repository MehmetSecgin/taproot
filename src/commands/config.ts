import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { badInput } from '../core/error-classification.js';
import { printJson } from '../core/output.js';
import {
  createSnapshot,
  diffAgainst,
  listSnapshots,
  pruneSnapshots,
  readHead,
  restoreSnapshot,
  statusAgainst,
} from '../core/config-snapshots.js';

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
      printJson({ snapshot: summary });
    });

  c.command('list')
    .description('List config snapshots, newest last')
    .action(() => {
      const ctx = getCtx();
      const snaps = listSnapshots(ctx.paths.configSnapshotsDir);
      const head = readHead(ctx.paths.configSnapshotsDir);
      const status = statusAgainst(ctx.paths.configDir, ctx.paths.configSnapshotsDir);
      printJson({
        head,
        drifted: status.drifted,
        snapshots: snaps.map((s) => ({ id: s.id, createdAt: s.createdAt, label: s.label, message: s.message, files: s.files.length, head: s.id === head })),
      });
    });

  c.command('status')
    .description('Report whether the current config has drifted from a snapshot (default: latest)')
    .option('--id <id>', 'compare against a specific snapshot instead of the latest')
    .action((opts) => {
      const ctx = getCtx();
      const report = statusAgainst(ctx.paths.configDir, ctx.paths.configSnapshotsDir, opts.id);
      printJson(report);
    });

  c.command('diff')
    .description('Show line-level differences between the current config and a snapshot (default: latest)')
    .option('--id <id>', 'diff against a specific snapshot instead of the latest')
    .action((opts) => {
      const ctx = getCtx();
      const result = diffAgainst(ctx.paths.configDir, ctx.paths.configSnapshotsDir, opts.id);
      printJson(result);
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
        throw badInput('Specify one of --id <id>, --label <label>, or --latest.');
      }
      const result = restoreSnapshot(
        ctx.paths.configDir,
        ctx.paths.configSnapshotsDir,
        { id: opts.id, label: opts.label, latest: opts.latest },
        { backup: opts.backup },
      );
      printJson(result);
    });

  c.command('prune')
    .description('Delete old snapshots, keeping the most recent N')
    .option('--keep <n>', 'number of snapshots to keep', '20')
    .action((opts) => {
      const ctx = getCtx();
      const keep = Number(opts.keep);
      if (!Number.isInteger(keep) || keep < 0) throw badInput(`Invalid --keep '${opts.keep}'. Expected a non-negative integer.`);
      const removed = pruneSnapshots(ctx.paths.configSnapshotsDir, keep);
      printJson({ removed, kept: keep });
    });
}
