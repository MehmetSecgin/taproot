#!/usr/bin/env node
import { Command } from 'commander';
import { buildContext } from './core/app.js';
import { printEnvelope } from './core/output.js';
import { registerSelfCheck } from './commands/self-check.js';
import { registerDoctor } from './commands/doctor.js';
import { registerQuery } from './commands/query.js';
import { registerDatasource } from './commands/datasource.js';
import { registerTemplate } from './commands/template.js';
import { registerKb } from './commands/kb.js';
import { registerCache } from './commands/cache.js';
import { registerLearn } from './commands/learn.js';
import { registerCompletion } from './commands/completion.js';
import { registerCreds } from './commands/creds.js';
import { registerSanitize } from './commands/sanitize.js';

const program = new Command();

program
  .name('telequery')
  .description('Universal query orchestration CLI with plugin runtime (DB-first v1)')
  .version('0.1.0')
  .option('--json', 'Output machine-readable JSON envelope', false)
  .option('--no-color', 'Disable ANSI colors')
  .option('--no-animations', 'Disable animations')
  .option('--profile <name>', 'Runtime profile name')
  .option('--memory-root <path>', 'Memory root override')
  .option('--skill-version', 'Print skill version and exit', false);

if (process.argv.includes('--skill-version')) {
  process.stdout.write('telequery-skill@0.1.0\n');
  process.exit(0);
}

function context() {
  const opts = program.opts();
  return buildContext({
    memoryRoot: opts.memoryRoot,
    jsonMode: Boolean(opts.json),
    noColor: Boolean(opts.noColor),
    noAnimations: Boolean(opts.noAnimations),
  });
}

registerSelfCheck(program, context);
registerDoctor(program, context);
registerQuery(program, context);
registerDatasource(program, context);
registerTemplate(program, context);
registerKb(program, context);
registerCache(program, context);
registerLearn(program, context);
registerCreds(program, context);
registerCompletion(program);
registerSanitize(program, context);

program.configureOutput({
  outputError: (str, write) => {
    const opts = program.opts();
    if (opts.json) {
      printEnvelope(false, undefined, { code: 'CLI_ERROR', message: String(str).trim() });
    } else {
      write(str);
    }
  },
});

program.parseAsync(process.argv).catch((error) => {
  const opts = program.opts();
  if (opts.json) {
    printEnvelope(false, undefined, { code: 'UNHANDLED', message: (error as Error).message });
  } else {
    console.error((error as Error).message);
  }
  process.exit(1);
});
