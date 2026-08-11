import { Command } from 'commander';
import fs from 'node:fs';
import path from 'node:path';
import type { AppContext } from '../core/app.js';
import { pruneRunArtifacts } from '../core/artifacts.js';
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
        { metric: 'schema observation entries', value: learning.files.schemaObservations },
        { metric: 'schema join entries', value: learning.files.schemaJoins },
        { metric: 'schema catalog entries', value: learning.files.schemaCatalog },
        { metric: 'grpc schema entries', value: learning.files.grpcSchemas },
      ]));
    }
  });

  c.command('prune').option('--ttl-hours <n>', 'default 168', '168').action((opts) => {
    const ctx = getCtx();
    const ttlHours = Number(opts.ttlHours);
    const learning = ctx.learningStore.prune(ttlHours);
    const runs = pruneRunArtifacts(ctx.paths.runsDir, Date.now() - ttlHours * 3600 * 1000);
    if (ctx.jsonMode) printJson({ learning, runs });
    else {
      console.log(`pruned learning: before=${learning.before} after=${learning.after}`);
      console.log(`pruned run artifacts: before=${runs.before} after=${runs.after}`);
    }
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
