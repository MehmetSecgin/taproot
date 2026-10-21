#!/usr/bin/env node
import { Command } from 'commander';
import { buildContext, nextAction } from './core/app.js';
import { printEnvelope, setOutputOptions } from './core/output.js';
import { registerSelfCheck } from './commands/self-check.js';
import { registerDoctor } from './commands/doctor.js';
import { registerQuery } from './commands/query.js';
import { registerDatasource } from './commands/datasource.js';
import { registerConfig } from './commands/config.js';
import { registerKb } from './commands/kb.js';
import { registerCache } from './commands/cache.js';
import { registerLearn } from './commands/learn.js';
import { registerCompletion } from './commands/completion.js';
import { registerCreds } from './commands/creds.js';
import { registerConnector } from './commands/connector.js';
import { registerSanitize } from './commands/sanitize.js';
import { registerDaemon } from './commands/daemon.js';
import { registerSession } from './commands/session.js';
import { registerInit } from './commands/init.js';
import { registerRun } from './commands/run.js';
import { registerBench } from './commands/bench.js';
import { registerDiscover } from './commands/discover.js';
import { registerGrpc } from './commands/grpc.js';
import { EXIT_CODES, classifyExitCode } from './core/exit-codes.js';
import { classifyError } from './core/error-classification.js';
import { TAPROOT_SKILL_VERSION, TAPROOT_VERSION } from './core/version.js';
import { str } from './core/strings.js';

const program = new Command();

program
  .name('taproot')
  .description('Universal query orchestration CLI with plugin runtime (DB-first v1)')
  .version(TAPROOT_VERSION)
  .option('--jsonl', 'Output JSON lines: query rows as one object per line, other arrays one item per line; errors as one CODE: message line on stderr', false)
  .option('--pluck <path>', 'Print only the subtree at this dot-path (e.g. data.rows, meta.schemaContext). On failure, print only the error object to stderr.')
  .option('--profile <name>', 'Runtime profile name')
  .option('--kb-dir <path>', 'Path to the KB directory (containing services.json). Overrides TAPROOT_KB_DIR and the directory saved by `taproot init --kb-dir`.')
  .option('--verbose', 'Diagnostics on stderr', false)
  .option('--skill-version', 'Print skill version and exit', false);

function applyOutputOptions(): void {
  const opts = program.opts();
  setOutputOptions({ pluck: opts.pluck ? String(opts.pluck) : undefined, jsonl: Boolean(opts.jsonl) });
}

program.hook('preAction', applyOutputOptions);

program.exitOverride((error) => {
  throw error;
});

if (process.argv.includes('--skill-version')) {
  process.stdout.write(`taproot-skill@${TAPROOT_SKILL_VERSION}\n`);
  process.exit(EXIT_CODES.OK);
}

function context() {
  const opts = program.opts();
  return buildContext({
    kbDir: opts.kbDir ? String(opts.kbDir) : undefined,
    verbose: Boolean(opts.verbose),
  });
}

registerSelfCheck(program, context);
registerDoctor(program, context);
registerQuery(program, context);
registerDatasource(program, context);
registerConfig(program, context);
registerKb(program, context);
registerCache(program, context);
registerLearn(program, context);
registerCreds(program, context);
registerConnector(program, context);
registerCompletion(program, context);
registerSanitize(program, context);
registerDaemon(program);
registerSession(program);
registerInit(program, context);
registerRun(program, context);
registerBench(program);
registerDiscover(program, context);
registerGrpc(program, context);

program.configureOutput({
  outputError: () => {
    // All command errors are emitted once via emitError() in the parseAsync catch block.
  },
});

function hasCredsTopologyMisuseHint(input: string): boolean {
  const m = input.toLowerCase();
  if (!/unknown option/.test(m)) return false;
  if (!/(--host|--port|--database|--target)/.test(m)) return false;
  return process.argv.includes('creds') && process.argv.includes('set');
}

function emitError(error: unknown, code: string): void {
  const message = (error as Error)?.message || String(error || 'Unknown error');
  const classifiedCode = code === 'UNHANDLED' || code === 'UNCAUGHT_EXCEPTION' || code === 'UNHANDLED_REJECTION'
    ? classifyError(message)
    : code;
  applyOutputOptions();
  const priorDetails = (error as Error & { details?: Record<string, unknown> })?.details;
  const details =
    priorDetails && typeof priorDetails === 'object' && 'nextAction' in priorDetails
      ? priorDetails
      : { ...(priorDetails || {}), nextAction: nextAction(classifiedCode) };
  const meta = (error as Error & { meta?: Record<string, unknown> })?.meta;
  printEnvelope(false, undefined, { code: classifiedCode, message, details }, meta);
}

process.on('unhandledRejection', (reason) => {
  emitError(reason, 'UNHANDLED_REJECTION');
  process.exit(classifyExitCode(reason));
});

process.on('uncaughtException', (error) => {
  emitError(error, 'UNCAUGHT_EXCEPTION');
  process.exit(classifyExitCode(error));
});

program.parseAsync(process.argv).catch((error) => {
  const commanderCode = str((error as { code?: string })?.code);
  if (commanderCode === 'commander.helpDisplayed' || commanderCode === 'commander.version') {
    process.exit(EXIT_CODES.OK);
    return;
  }
  if (commanderCode.startsWith('commander.')) {
    const message = (error as Error)?.message || '';
    const details = hasCredsTopologyMisuseHint(message)
      ? { nextAction: "Connection topology belongs on datasource profiles. Use 'taproot datasource add ... --host --port --database --target'." }
      : undefined;
    applyOutputOptions();
    printEnvelope(false, undefined, { code: 'CLI_ERROR', message, details });
    process.exit(classifyExitCode(error));
    return;
  }
  emitError(error, 'UNHANDLED');
  process.exit(classifyExitCode(error));
});
