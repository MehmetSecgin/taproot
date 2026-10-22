#!/usr/bin/env node
import { Command, type Help } from 'commander';
import { buildContext } from './core/app.js';
import { printEnvelope, printJson, setPluck } from './core/output.js';
import { registerDoctor } from './commands/doctor.js';
import { registerQuery } from './commands/query.js';
import { registerDatasource } from './commands/datasource.js';
import { registerKb } from './commands/kb.js';
import { registerCreds } from './commands/creds.js';
import { registerDaemon } from './commands/daemon.js';
import { registerInit } from './commands/init.js';
import { registerGrpc } from './commands/grpc.js';
import { EXIT_CODES, classifyExitCode } from './core/exit-codes.js';
import { classifyError } from './core/error-classification.js';
import { removedCliHint } from './core/removed-cli.js';
import { TAPROOT_VERSION } from './core/version.js';
import { str } from './core/strings.js';

if (process.argv[2] === '-V' || process.argv[2] === '--version') {
  printJson({ version: TAPROOT_VERSION });
  process.exit(EXIT_CODES.OK);
}

function helpJson(cmd: Command, helper: Help): string {
  const data = {
    usage: helper.commandUsage(cmd),
    description: helper.commandDescription(cmd) || undefined,
    arguments: helper.visibleArguments(cmd).map((a) => ({ name: helper.argumentTerm(a), description: helper.argumentDescription(a) || undefined })),
    options: helper.visibleOptions(cmd).map((o) => ({ flags: helper.optionTerm(o), description: helper.optionDescription(o) || undefined })),
    commands: helper.visibleCommands(cmd).map((c) => ({ name: helper.subcommandTerm(c), description: helper.subcommandDescription(c) || undefined })),
  };
  return `${JSON.stringify({ ok: true, data })}\n`;
}

const program = new Command();

program
  .name('taproot')
  .description('Universal query orchestration CLI with plugin runtime (DB-first v1)')
  .option('-V, --version', 'Print the version')
  .option('--pluck <path>', 'Print only the subtree at this dot-path (e.g. data.rows, meta.schemaContext). A failure prints the full error envelope.')
  .option('--kb-dir <path>', 'Path to the KB directory (containing services.json). Overrides TAPROOT_KB_DIR and the directory saved by `taproot init --kb-dir`.')
  .option('--verbose', 'Diagnostics on stderr as JSON lines', false)
  .configureHelp({ formatHelp: helpJson })
  .configureOutput({
    writeErr: (text) => process.stdout.write(text),
    outputError: () => {
      // All command errors are emitted once via emitError() in the parseAsync catch block.
    },
  });

function applyOutputOptions(): void {
  const opts = program.opts();
  setPluck(opts.pluck ? String(opts.pluck) : undefined);
}

program.hook('preAction', applyOutputOptions);

program.exitOverride((error) => {
  throw error;
});

function context() {
  const opts = program.opts();
  return buildContext({
    kbDir: opts.kbDir ? String(opts.kbDir) : undefined,
    verbose: Boolean(opts.verbose),
  });
}

registerDoctor(program, context);
registerQuery(program, context);
registerDatasource(program, context);
registerKb(program, context);
registerCreds(program, context);
registerDaemon(program);
registerInit(program, context);
registerGrpc(program, context);

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
  const details = (error as Error & { details?: Record<string, unknown> })?.details;
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
  if (commanderCode === 'commander.helpDisplayed' || commanderCode === 'commander.help') {
    process.exit(EXIT_CODES.OK);
    return;
  }
  if (commanderCode.startsWith('commander.')) {
    const raw = (error as Error)?.message || '';
    const message = hasCredsTopologyMisuseHint(raw)
      ? `${raw}. Connection topology (--host, --port, --database, --target) belongs on the datasource profile ('taproot datasource add'), not on credentials.`
      : removedCliHint(raw) ?? raw;
    applyOutputOptions();
    printEnvelope(false, undefined, { code: 'CLI_ERROR', message });
    process.exit(classifyExitCode(error));
    return;
  }
  emitError(error, 'UNHANDLED');
  process.exit(classifyExitCode(error));
});
