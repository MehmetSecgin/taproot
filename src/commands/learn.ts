import { Command } from 'commander';
import type { AppContext } from '../core/app.js';
import { printJson } from '../core/output.js';

export function registerLearn(program: Command, getCtx: () => AppContext): void {
  const l = program.command('learn').description('Learning cache operations');

  l.command('status').action(() => {
    const ctx = getCtx();
    printJson(ctx.learningStore.status());
  });

  l.command('compact').action(() => {
    const ctx = getCtx();
    printJson(ctx.learningStore.compact());
  });

  l.command('replay').requiredOption('--run-id <id>').action((opts) => {
    const ctx = getCtx();
    // v1 placeholder: replay support will read run artifacts in a later iteration.
    printJson({ replayed: false, runId: opts.runId, note: 'Replay scaffold in place; artifact-based replay follows next increment.' });
  });
}
