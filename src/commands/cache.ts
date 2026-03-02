import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../core/app.js';
import { printJson } from '../core/output.js';

export function registerCache(program: Command, getCtx: () => AppContext): void {
  const c = program.command('cache').description('Cache maintenance commands');

  c.command('show').action(() => {
    const ctx = getCtx();
    const files = fs.readdirSync(ctx.paths.cacheDir, { withFileTypes: true }).map((d) => d.name);
    const learning = ctx.learningStore.status();
    printJson({ cacheDir: ctx.paths.cacheDir, files, learning });
  });

  c.command('prune').option('--ttl-hours <n>', 'default 168', '168').action((opts) => {
    const ctx = getCtx();
    const res = ctx.learningStore.prune(Number(opts.ttlHours));
    printJson(res);
  });

  c.command('clear').option('--kind <kind>', 'all|learning', 'all').action((opts) => {
    const ctx = getCtx();
    if (opts.kind === 'learning' || opts.kind === 'all') ctx.learningStore.clear();
    if (opts.kind === 'all') {
      for (const name of fs.readdirSync(ctx.paths.cacheDir)) {
        fs.rmSync(path.join(ctx.paths.cacheDir, name), { recursive: true, force: true });
      }
    }
    printJson({ cleared: opts.kind });
  });
}
