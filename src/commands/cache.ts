import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../core/app.js';
import { printJson, renderRecord, renderTable } from '../core/output.js';

export function registerCache(program: Command, getCtx: () => AppContext): void {
  const c = program.command('cache').description('Cache maintenance commands');

  c.command('show').action(() => {
    const ctx = getCtx();
    const files = fs.readdirSync(ctx.paths.cacheDir, { withFileTypes: true }).map((d) => d.name);
    const learning = ctx.learningStore.status();
    if (ctx.jsonMode) printJson({ cacheDir: ctx.paths.cacheDir, files, learning });
    else {
      console.log(renderRecord({ cacheDir: ctx.paths.cacheDir, fileCount: files.length, latestLearnedAt: learning.latest || '' }));
      console.log(renderTable([
        { metric: 'resolution entries', value: learning.files.resolution },
        { metric: 'query library entries', value: learning.files.queryLibrary },
        { metric: 'query stats entries', value: learning.files.queryStats },
      ]));
    }
  });

  c.command('prune').option('--ttl-hours <n>', 'default 168', '168').action((opts) => {
    const ctx = getCtx();
    const res = ctx.learningStore.prune(Number(opts.ttlHours));
    if (ctx.jsonMode) printJson(res);
    else console.log(`pruned: before=${res.before} after=${res.after}`);
  });

  c.command('clear').option('--kind <kind>', 'all|learning', 'all').action((opts) => {
    const ctx = getCtx();
    if (opts.kind === 'learning' || opts.kind === 'all') ctx.learningStore.clear();
    if (opts.kind === 'all') {
      for (const name of fs.readdirSync(ctx.paths.cacheDir)) {
        fs.rmSync(path.join(ctx.paths.cacheDir, name), { recursive: true, force: true });
      }
    }
    if (ctx.jsonMode) printJson({ cleared: opts.kind });
    else console.log(`cleared: ${opts.kind}`);
  });
}
