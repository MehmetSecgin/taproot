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
import { registerConnector } from './commands/connector.js';
import { registerSanitize } from './commands/sanitize.js';
import { registerDaemon } from './commands/daemon.js';
import { registerSession } from './commands/session.js';
import { registerInit } from './commands/init.js';
import { registerCard } from './commands/card.js';
import { registerRun } from './commands/run.js';
import { registerBench } from './commands/bench.js';
import { registerIdea } from './commands/idea.js';
import { registerDiscover } from './commands/discover.js';
import { registerGrpc } from './commands/grpc.js';
import { EXIT_CODES, classifyExitCode } from './core/exit-codes.js';
import { classifyError } from './core/error-classification.js';
import { cleanupProgress } from './core/progress.js';
import { TAPROOT_SKILL_VERSION, TAPROOT_VERSION } from './core/version.js';

const program = new Command();

program
  .name('taproot')
  .description('Universal query orchestration CLI with plugin runtime (DB-first v1)')
  .version(TAPROOT_VERSION)
  .option('--json', 'Output machine-readable JSON envelope', false)
  .option('--no-color', 'Disable ANSI colors')
  .option('--no-animations', 'Disable animations')
  .option('--profile <name>', 'Runtime profile name')
  .option('--kb-dir <path>', 'Path to the KB directory (containing services.json). Overrides TAPROOT_KB_DIR.')
  .option('--memory-root <path>', 'Deprecated alias for --kb-dir (treated as a memory root with the legacy `domains/engineering/references/db-kb` subpath).')
  .option('--verbose', 'Verbose progress and diagnostics', false)
  .option('--datetime-format <fmt>', 'Render Date columns as iso|js|epoch (default iso)')
  .option('--skill-version', 'Print skill version and exit', false);

program.hook('preAction', () => {
  const fmt = String(program.opts().datetimeFormat || '').trim().toLowerCase();
  if (fmt === 'iso' || fmt === 'js' || fmt === 'epoch') {
    process.env.TAPROOT_DATETIME_FORMAT = fmt;
  } else if (fmt) {
    throw new Error(`Invalid --datetime-format '${fmt}'. Expected iso|js|epoch.`);
  }
});

program.exitOverride((error) => {
  throw error;
});

if (process.argv.includes('--skill-version')) {
  process.stdout.write(`taproot-skill@${TAPROOT_SKILL_VERSION}\n`);
  process.exit(EXIT_CODES.OK);
}

function legacyMemoryRootToKbDir(memoryRoot: string): string {
  return `${memoryRoot}/domains/engineering/references/db-kb`;
}

function context() {
  const opts = program.opts();
  const kbDir = opts.kbDir
    ? String(opts.kbDir)
    : opts.memoryRoot
      ? legacyMemoryRootToKbDir(String(opts.memoryRoot))
      : undefined;
  return buildContext({
    kbDir,
    jsonMode: Boolean(opts.json),
    noColor: Boolean(opts.noColor),
    noAnimations: Boolean(opts.noAnimations),
    verbose: Boolean(opts.verbose),
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
registerConnector(program, context);
registerCompletion(program, context);
registerSanitize(program, context);
registerDaemon(program, context);
registerSession(program, context);
registerInit(program, context);
registerCard(program, context);
registerRun(program, context);
registerBench(program, context);
registerIdea(program, context);
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
  cleanupProgress();
  const message = (error as Error)?.message || String(error || 'Unknown error');
  const classifiedCode = code === 'UNHANDLED' || code === 'UNCAUGHT_EXCEPTION' || code === 'UNHANDLED_REJECTION'
    ? classifyError(message)
    : code;
  const jsonMode = process.argv.includes('--json');
  if (jsonMode) {
    printEnvelope(
      false,
      undefined,
      { code: classifiedCode, message, details: (error as Error & { details?: unknown })?.details },
      (error as Error & { meta?: Record<string, unknown> })?.meta,
    );
    return;
  }
  console.error(message);
  if (hasCredsTopologyMisuseHint(message)) {
    console.error("Hint: connection topology belongs on datasource profiles. Use 'taproot datasource add ... --host --port --database --target'.");
  }
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
  const commanderCode = String((error as { code?: string })?.code || '');
  if (commanderCode === 'commander.helpDisplayed' || commanderCode === 'commander.version') {
    process.exit(EXIT_CODES.OK);
    return;
  }
  if (commanderCode.startsWith('commander.')) {
    cleanupProgress();
    const message = (error as Error)?.message || '';
    if (hasCredsTopologyMisuseHint(message)) {
      console.error("Hint: connection topology belongs on datasource profiles. Use 'taproot datasource add ... --host --port --database --target'.");
    } else if (process.argv.includes('--json')) {
      printEnvelope(false, undefined, { code: 'CLI_ERROR', message });
    }
    process.exit(classifyExitCode(error));
    return;
  }
  emitError(error, 'UNHANDLED');
  process.exit(classifyExitCode(error));
});
